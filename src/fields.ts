import type { ManagedCollection, ManagedCollectionFieldInput } from "framer-plugin"

export const FIELD_IDS = {
    title: "title",
    tag: "tag",
    body: "body",
    publishedAt: "published_at",
    isLatest: "is_latest",
    isPrerelease: "is_prerelease",
    compareUrl: "compare_url",
    githubUrl: "github_url",
    author: "author",
    authorAvatar: "author_avatar",
} as const

export type ReleaseFieldId = (typeof FIELD_IDS)[keyof typeof FIELD_IDS]

export type ConfigurableFieldType = "boolean" | "date" | "formattedText" | "image" | "link" | "string"

export interface ReleaseFieldConfig {
    id: ReleaseFieldId
    sourceName: string
    name: string
    type: ConfigurableFieldType
    enabled: boolean
}

export const DEFAULT_FIELD_CONFIGS = [
    {
        id: FIELD_IDS.title,
        sourceName: "Title",
        name: "Title",
        type: "string",
        enabled: true,
    },
    {
        id: FIELD_IDS.tag,
        sourceName: "Tag",
        name: "Tag",
        type: "string",
        enabled: true,
    },
    {
        id: FIELD_IDS.body,
        sourceName: "Body",
        name: "Body",
        type: "formattedText",
        enabled: true,
    },
    {
        id: FIELD_IDS.publishedAt,
        sourceName: "Published At",
        name: "Published At",
        type: "date",
        enabled: true,
    },
    {
        id: FIELD_IDS.isLatest,
        sourceName: "Is Latest",
        name: "Is Latest",
        type: "boolean",
        enabled: true,
    },
    {
        id: FIELD_IDS.isPrerelease,
        sourceName: "Is Prerelease",
        name: "Is Prerelease",
        type: "boolean",
        enabled: true,
    },
    {
        id: FIELD_IDS.compareUrl,
        sourceName: "Compare URL",
        name: "Compare URL",
        type: "link",
        enabled: true,
    },
    {
        id: FIELD_IDS.githubUrl,
        sourceName: "GitHub URL",
        name: "GitHub URL",
        type: "link",
        enabled: true,
    },
    {
        id: FIELD_IDS.author,
        sourceName: "Author",
        name: "Author",
        type: "string",
        enabled: true,
    },
    {
        id: FIELD_IDS.authorAvatar,
        sourceName: "Author Avatar",
        name: "Author Avatar",
        type: "image",
        enabled: true,
    },
] as const satisfies readonly ReleaseFieldConfig[]

export function createDefaultFieldConfigs(): ReleaseFieldConfig[] {
    return DEFAULT_FIELD_CONFIGS.map(field => ({ ...field }))
}

export function toManagedCollectionFields(configs: readonly ReleaseFieldConfig[]): ManagedCollectionFieldInput[] {
    return configs
        .filter(config => config.enabled)
        .map(config => {
            const field = {
                id: config.id,
                name: config.name.trim() || config.sourceName,
                type: config.type,
            }

            if (config.type === "date") {
                return {
                    ...field,
                    displayTime: false,
                }
            }

            return field
        })
}

export async function configureReleasesCollection(
    collection: ManagedCollection,
    configs: readonly ReleaseFieldConfig[] = createDefaultFieldConfigs()
) {
    await collection.setFields(toManagedCollectionFields(configs))
}

export function serializeFieldConfigs(configs: readonly ReleaseFieldConfig[]): string {
    return JSON.stringify({
        version: 1,
        fields: configs.map(config => [config.id, config.name, config.enabled ? 1 : 0]),
    })
}

export function parseFieldConfigs(value: string | null): ReleaseFieldConfig[] {
    const defaults = createDefaultFieldConfigs()
    if (!value) return defaults

    try {
        const parsed = JSON.parse(value) as unknown
        if (!isStoredFieldConfig(parsed)) return defaults

        const savedFields = new Map(parsed.fields.map(field => [field[0], field]))

        return defaults.map(defaultConfig => {
            const savedField = savedFields.get(defaultConfig.id)
            if (!savedField) return defaultConfig

            const [, name, enabled] = savedField

            return {
                ...defaultConfig,
                name: name.trim() || defaultConfig.name,
                enabled: defaultConfig.id === FIELD_IDS.title ? true : enabled === 1,
            }
        })
    } catch {
        return defaults
    }
}

type StoredFieldTuple = [ReleaseFieldId, string, 0 | 1]

interface StoredFieldConfig {
    version: 1
    fields: StoredFieldTuple[]
}

function isStoredFieldConfig(value: unknown): value is StoredFieldConfig {
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.fields)) return false

    return value.fields.every(field => {
        if (!Array.isArray(field) || field.length !== 3) return false

        const [id, name, enabled] = field
        return isReleaseFieldId(id) && typeof name === "string" && (enabled === 0 || enabled === 1)
    })
}

function isReleaseFieldId(value: unknown): value is ReleaseFieldId {
    return typeof value === "string" && Object.values(FIELD_IDS).includes(value as ReleaseFieldId)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null
}
