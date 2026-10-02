import DOMPurify from "dompurify"
import {
    type FieldDataEntryInput,
    type FieldDataInput,
    type ManagedCollection,
    type ManagedCollectionItemInput,
    type ProtectedMethod,
} from "@framer/plugin"
import { marked } from "marked"
import {
    configureReleasesCollection,
    createDefaultFieldConfigs,
    FIELD_IDS,
    serializeFieldConfigs,
    type ReleaseFieldConfig,
    type ReleaseFieldId,
} from "./fields"

export const PLUGIN_DATA_KEYS = {
    REPO_URL: "repoUrl",
    REPO_FULL_NAME: "repoFullName",
    FIELD_CONFIGS: "fieldConfigs",
    SLUG_STRATEGY: "slugStrategy",
    LAST_SYNCED_AT: "lastSyncedAt",
    LAST_RELEASE_COUNT: "lastReleaseCount",
} as const

export const SYNC_METHODS = [
    "ManagedCollection.setFields",
    "ManagedCollection.addItems",
    "ManagedCollection.removeItems",
    "ManagedCollection.setPluginData",
] as const satisfies ProtectedMethod[]

const repoPartPattern = /^[A-Za-z0-9_.-]+$/
const githubReleasePageSize = 100
const githubRequestTimeoutMs = 20_000
const maxSlugLength = 64
const maxSummaryLength = 180
const defaultSlugStrategy: SlugStrategy = "repository-tag"

export class GitHubRequestTimeoutError extends Error {
    constructor(cause: unknown) {
        super("GitHub did not respond in time. Check your connection and try again.", { cause })
        this.name = "GitHubRequestTimeoutError"
    }
}

export type SlugStrategy = "repository-tag" | "repository-short-hash"

export interface RepoInfo {
    owner: string
    repo: string
    fullName: string
    url: string
}

export interface SyncResult {
    repo: RepoInfo
    releaseCount: number
}

interface GitHubUser {
    login?: unknown
    avatar_url?: unknown
}

interface GitHubReleaseAsset {
    browser_download_url?: unknown
    name?: unknown
    label?: unknown
    state?: unknown
    size?: unknown
    download_count?: unknown
    digest?: unknown
}

export interface GitHubRelease {
    id?: unknown
    tag_name?: unknown
    name?: unknown
    body?: unknown
    draft?: unknown
    prerelease?: unknown
    published_at?: unknown
    html_url?: unknown
    discussion_url?: unknown
    zipball_url?: unknown
    tarball_url?: unknown
    target_commitish?: unknown
    immutable?: unknown
    assets?: unknown
    author?: GitHubUser | null
}

export function parseRepoInput(input: string): RepoInfo {
    const trimmedInput = input.trim()
    if (!trimmedInput) {
        throw new Error("Enter a public GitHub repository URL.")
    }

    const normalizedInput = trimmedInput.includes("://") ? trimmedInput : `https://${trimmedInput}`
    let url: URL

    try {
        url = new URL(normalizedInput)
    } catch {
        throw new Error("Enter a valid GitHub repository URL.")
    }

    if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
        throw new Error("Use a github.com repository URL.")
    }

    const [owner, rawRepo] = url.pathname.split("/").filter(Boolean)
    const repo = rawRepo?.replace(/\.git$/u, "")

    if (!owner || !repo || !repoPartPattern.test(owner) || !repoPartPattern.test(repo)) {
        throw new Error("Use a GitHub URL like github.com/framer/plugins.")
    }

    return {
        owner,
        repo,
        fullName: `${owner}/${repo}`,
        url: `https://github.com/${owner}/${repo}`,
    }
}

export async function fetchGitHubReleases(repo: RepoInfo, abortSignal?: AbortSignal): Promise<GitHubRelease[]> {
    const releases: GitHubRelease[] = []
    const releasesPath = `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/releases`
    let nextUrl: string | null = `https://api.github.com${releasesPath}?per_page=${githubReleasePageSize}`
    const fetchedUrls = new Set<string>()

    while (nextUrl) {
        const pageUrl = new URL(nextUrl)
        const isReleasePage =
            pageUrl.pathname === releasesPath || /^\/repositories\/\d+\/releases$/u.test(pageUrl.pathname)
        if (pageUrl.origin !== "https://api.github.com" || !isReleasePage || fetchedUrls.has(nextUrl)) {
            throw new Error("GitHub returned an unexpected releases page. No collection items were changed.")
        }
        fetchedUrls.add(nextUrl)

        const controller = new AbortController()
        const abortRequest = () => controller.abort()
        if (abortSignal?.aborted) abortRequest()
        else abortSignal?.addEventListener("abort", abortRequest, { once: true })
        const timeout = setTimeout(abortRequest, githubRequestTimeoutMs)

        try {
            const response = await fetch(nextUrl, {
                headers: {
                    Accept: "application/vnd.github+json",
                },
                signal: controller.signal,
            })

            if (!response.ok) {
                throw await createGitHubError(response, repo)
            }

            const page = (await response.json()) as unknown
            if (!Array.isArray(page)) {
                throw new Error("GitHub returned an unexpected releases response.")
            }

            releases.push(...(page as GitHubRelease[]))
            nextUrl = getNextPageUrl(response.headers.get("Link"))
        } catch (error) {
            if (controller.signal.aborted && !abortSignal?.aborted) {
                throw new GitHubRequestTimeoutError(error)
            }
            throw error
        } finally {
            clearTimeout(timeout)
            abortSignal?.removeEventListener("abort", abortRequest)
        }
    }

    return releases
}

export async function syncReleases(
    collection: ManagedCollection,
    repoInput: string,
    fieldConfigs: readonly ReleaseFieldConfig[] = createDefaultFieldConfigs(),
    slugStrategy: SlugStrategy = defaultSlugStrategy,
    abortSignal?: AbortSignal
): Promise<SyncResult> {
    const repo = parseRepoInput(repoInput)
    const releases = await fetchGitHubReleases(repo, abortSignal)
    return syncReleaseData(collection, repo, releases, fieldConfigs, slugStrategy)
}

export async function syncReleaseData(
    collection: ManagedCollection,
    repo: RepoInfo,
    releases: readonly GitHubRelease[],
    fieldConfigs: readonly ReleaseFieldConfig[] = createDefaultFieldConfigs(),
    slugStrategy: SlugStrategy = defaultSlugStrategy
): Promise<SyncResult> {
    if (releases.length === 0) {
        throw new Error(`No releases found for ${repo.fullName}. No collection items were changed.`)
    }

    await configureReleasesCollection(collection, fieldConfigs)
    const existingItemIds = new Set(await collection.getItemIds())
    const usedSlugs = new Set<string>()
    const latestReleaseId = releases.find(release => !release.draft && !release.prerelease)?.id
    const items = releases.map((release, index) => {
        const nextRelease = releases[index + 1]
        const previousTag = nextRelease ? readString(nextRelease.tag_name) : ""
        const item = mapReleaseToItem(release, {
            compareUrl: createCompareUrl(repo, previousTag, readString(release.tag_name)),
            fieldConfigs,
            isLatest: latestReleaseId !== undefined && String(latestReleaseId) === String(release.id),
            repoName: repo.repo,
            slugStrategy,
            usedSlugs,
        })
        existingItemIds.delete(item.id)
        return item
    })

    await collection.addItems(items)
    await collection.removeItems(Array.from(existingItemIds))

    await collection.setPluginData(PLUGIN_DATA_KEYS.REPO_URL, repo.url)
    await collection.setPluginData(PLUGIN_DATA_KEYS.REPO_FULL_NAME, repo.fullName)
    await collection.setPluginData(PLUGIN_DATA_KEYS.FIELD_CONFIGS, serializeFieldConfigs(fieldConfigs))
    await collection.setPluginData(PLUGIN_DATA_KEYS.SLUG_STRATEGY, slugStrategy)
    await collection.setPluginData(PLUGIN_DATA_KEYS.LAST_SYNCED_AT, new Date().toISOString())
    await collection.setPluginData(PLUGIN_DATA_KEYS.LAST_RELEASE_COUNT, String(releases.length))

    return {
        repo,
        releaseCount: releases.length,
    }
}

interface ReleaseMappingOptions {
    compareUrl: string | null
    fieldConfigs: readonly ReleaseFieldConfig[]
    isLatest: boolean
    repoName: string
    slugStrategy: SlugStrategy
    usedSlugs: Set<string>
}

function mapReleaseToItem(release: GitHubRelease, options: ReleaseMappingOptions): ManagedCollectionItemInput {
    const id = readReleaseId(release)
    const tag = readString(release.tag_name) || id
    const title = readString(release.name) || tag
    const author = release.author
    const authorName = readString(author?.login)
    const authorAvatar = readString(author?.avatar_url)
    const body = markdownToHtml(readString(release.body))
    const assets = readUploadedAssets(release.assets)
    const publishedAt = readString(release.published_at)
    const githubUrl = readString(release.html_url)
    const isDraft = Boolean(release.draft)

    const values: ReleaseFieldValues = {
        [FIELD_IDS.title]: title,
        [FIELD_IDS.tag]: tag,
        [FIELD_IDS.summary]: htmlToSummary(body),
        [FIELD_IDS.body]: body,
        [FIELD_IDS.publishedAt]: publishedAt || null,
        [FIELD_IDS.isLatest]: options.isLatest,
        [FIELD_IDS.isPrerelease]: Boolean(release.prerelease),
        [FIELD_IDS.downloads]: assets ? assetsToHtml(assets) : "",
        [FIELD_IDS.totalDownloads]: assets
            ? assets.reduce((total, asset) => total + readNonnegativeNumber(asset.download_count), 0)
            : null,
        [FIELD_IDS.discussionUrl]: readGitHubUrl(release.discussion_url),
        [FIELD_IDS.sourceZipUrl]: readGitHubUrl(release.zipball_url),
        [FIELD_IDS.sourceTarUrl]: readGitHubUrl(release.tarball_url),
        [FIELD_IDS.compareUrl]: options.compareUrl,
        [FIELD_IDS.githubUrl]: githubUrl || null,
        [FIELD_IDS.author]: authorName,
        [FIELD_IDS.authorAvatar]: authorAvatar || null,
        [FIELD_IDS.targetCommitish]: readString(release.target_commitish),
        [FIELD_IDS.isImmutable]: typeof release.immutable === "boolean" ? release.immutable : null,
    }

    return {
        id,
        slug: createUniqueSlug(options.repoName, tag, id, options.slugStrategy, options.usedSlugs),
        draft: isDraft,
        fieldData: buildFieldData(values, options.fieldConfigs, authorName),
    }
}

export function parseSlugStrategy(value: string | null): SlugStrategy {
    if (value === "repository-short-hash") return value
    return defaultSlugStrategy
}

type ReleaseFieldValue = string | boolean | number | null
type ReleaseFieldValues = Record<ReleaseFieldId, ReleaseFieldValue>

function buildFieldData(
    values: ReleaseFieldValues,
    fieldConfigs: readonly ReleaseFieldConfig[],
    authorName: string
): FieldDataInput {
    const fieldData: FieldDataInput = {}

    for (const config of fieldConfigs) {
        if (!config.enabled) continue

        const fieldEntry = buildFieldDataEntry(values[config.id], config, authorName)
        if (!fieldEntry) continue

        fieldData[config.id] = fieldEntry
    }

    return fieldData
}

function buildFieldDataEntry(
    value: ReleaseFieldValue,
    config: ReleaseFieldConfig,
    authorName: string
): FieldDataEntryInput | undefined {
    switch (config.type) {
        case "boolean":
            if (typeof value !== "boolean") return undefined
            return { type: "boolean", value }
        case "date":
            return { type: "date", value: typeof value === "string" ? value : null }
        case "formattedText":
            return {
                type: "formattedText",
                value: typeof value === "string" ? value : "",
                contentType: "html",
            }
        case "image":
            return {
                type: "image",
                value: typeof value === "string" && value ? value : null,
                alt: authorName ? `${authorName} avatar` : "GitHub release author avatar",
            }
        case "link":
            return { type: "link", value: typeof value === "string" && value ? value : null }
        case "number":
            return typeof value === "number" ? { type: "number", value } : undefined
        case "string":
            return { type: "string", value: stringifyValue(value) }
    }
}

function markdownToHtml(markdown: string): string {
    if (!markdown) return ""

    const html = marked.parse(markdown, {
        async: false,
        breaks: true,
        gfm: true,
    }) as string

    return DOMPurify.sanitize(html)
}

function htmlToSummary(html: string): string {
    if (!html) return ""

    const text = new DOMParser().parseFromString(html, "text/html").body.textContent?.replace(/\s+/gu, " ").trim() ?? ""
    if (text.length <= maxSummaryLength) return text

    const lastSpace = text.lastIndexOf(" ", maxSummaryLength)
    return `${text.slice(0, lastSpace > maxSummaryLength / 2 ? lastSpace : maxSummaryLength).trimEnd()}…`
}

function readUploadedAssets(value: unknown): GitHubReleaseAsset[] | null {
    if (!Array.isArray(value)) return null
    return (value as GitHubReleaseAsset[]).filter(
        asset => asset && (asset.state === undefined || asset.state === "uploaded")
    )
}

function assetsToHtml(assets: readonly GitHubReleaseAsset[]): string {
    const items = assets.flatMap(asset => {
        const url = readGitHubUrl(asset.browser_download_url)
        if (!url) return []

        const name = readString(asset.label) || readString(asset.name) || "Download"
        const details = [
            readAssetSize(asset.size),
            typeof asset.download_count === "number" &&
            Number.isFinite(asset.download_count) &&
            asset.download_count >= 0
                ? `${asset.download_count.toLocaleString("en-US")} downloads`
                : "",
        ].filter(Boolean)
        const digest = readString(asset.digest)
        const metadata = details.length ? ` <small>(${escapeHtml(details.join(" · "))})</small>` : ""
        const checksum = digest ? ` <code>${escapeHtml(digest)}</code>` : ""
        return [`<li><a href="${escapeHtml(url)}">${escapeHtml(name)}</a>${metadata}${checksum}</li>`]
    })

    return items.length ? DOMPurify.sanitize(`<ul>${items.join("")}</ul>`) : ""
}

function readAssetSize(value: unknown): string {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return ""
    if (value < 1024) return `${value} B`
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
    return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

function readNonnegativeNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function readGitHubUrl(value: unknown): string | null {
    if (typeof value !== "string") return null

    try {
        const url = new URL(value)
        return url.protocol === "https:" && (url.hostname === "github.com" || url.hostname === "api.github.com")
            ? url.toString()
            : null
    } catch {
        return null
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/gu, character => {
        switch (character) {
            case "&":
                return "&amp;"
            case "<":
                return "&lt;"
            case ">":
                return "&gt;"
            case '"':
                return "&quot;"
            default:
                return "&#39;"
        }
    })
}

function readReleaseId(release: GitHubRelease): string {
    const id = release.id
    if (typeof id === "number" || typeof id === "string") {
        return String(id)
    }

    throw new Error("A GitHub release did not include a stable id.")
}

function readString(value: unknown): string {
    return typeof value === "string" ? value : ""
}

function stringifyValue(value: ReleaseFieldValue): string {
    if (typeof value === "boolean") return value ? "Yes" : "No"
    if (typeof value === "number") return String(value)
    return value ?? ""
}

function createUniqueSlug(
    repoName: string,
    tag: string,
    id: string,
    slugStrategy: SlugStrategy,
    usedSlugs: Set<string>
): string {
    const slugValue = slugStrategy === "repository-short-hash" ? createShortHash(`${repoName}:${id}`) : tag
    const baseSlug = trimSlug(slugify(`${repoName}-${slugValue}`)) || `release-${id}`
    let slug = truncateSlug(baseSlug, maxSlugLength)

    if (usedSlugs.has(slug)) {
        const suffix = `-${id.slice(-8)}`
        slug = `${truncateSlug(baseSlug, maxSlugLength - suffix.length)}${suffix}`
    }

    usedSlugs.add(slug)
    return slug
}

function createShortHash(value: string): string {
    let hash = 0x811c9dc5

    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
    }

    return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6)
}

function slugify(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^a-z0-9.]+/gu, "-")
        .replace(/^[.-]+|[.-]+$/gu, "")
}

function truncateSlug(slug: string, maxLength: number): string {
    return trimSlug(slug.slice(0, maxLength))
}

function trimSlug(slug: string): string {
    return slug.replace(/^[.-]+|[.-]+$/gu, "")
}

function createCompareUrl(repo: RepoInfo, previousTag: string, currentTag: string): string | null {
    if (!previousTag || !currentTag) return null

    return `https://github.com/${repo.fullName}/compare/${encodeURIComponent(previousTag)}...${encodeURIComponent(currentTag)}`
}

function getNextPageUrl(linkHeader: string | null): string | null {
    if (!linkHeader) return null

    for (const link of linkHeader.split(",")) {
        const [urlPart, relPart] = link.split(";").map(part => part.trim())
        if (relPart === 'rel="next"') {
            return urlPart.slice(1, -1)
        }
    }

    return null
}

async function createGitHubError(response: Response, repo: RepoInfo): Promise<Error> {
    let details = ""

    try {
        const body = (await response.json()) as { message?: unknown }
        details = readString(body.message)
    } catch {
        details = response.statusText
    }

    if (response.status === 404) {
        return new Error(`GitHub could not find ${repo.fullName}. Check that the repository is public.`)
    }

    if (response.status === 403 && response.headers.get("X-RateLimit-Remaining") === "0") {
        return new Error("GitHub rate limit reached. Wait a bit, then sync again.")
    }

    return new Error(`GitHub returned ${response.status}${details ? `: ${details}` : "."}`)
}
