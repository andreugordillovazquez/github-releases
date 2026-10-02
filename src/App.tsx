import "./App.css"

import { FramerPluginClosedError, framer, type ManagedCollection, useIsAllowedTo } from "@framer/plugin"
import { type FormEvent, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { FIELD_IDS, type ReleaseFieldConfig } from "./fields"
import {
    type GitHubRelease,
    type RepoInfo,
    type SlugStrategy,
    SYNC_METHODS,
    fetchGitHubReleases,
    parseRepoInput,
    syncReleaseData,
} from "./github"

interface AppProps {
    collection: ManagedCollection
    initialRepoUrl: string | null
    initialFieldConfigs: ReleaseFieldConfig[]
    initialSlugStrategy: SlugStrategy
}

type Step = "repo" | "fields"
type Status = "idle" | "fetching" | "syncing" | "error"

const REPO_SCREEN_FALLBACK_HEIGHT = 287
const CLOSE_WARNING_MESSAGE = "GitHub releases are still syncing. Close anyway?"

export function App({
    collection,
    initialRepoUrl,
    initialFieldConfigs,
    initialSlugStrategy,
}: AppProps) {
    const screenRef = useRef<HTMLElement | null>(null)
    const initialRepo = useMemo(() => parseInitialRepo(initialRepoUrl), [initialRepoUrl])
    const [step, setStep] = useState<Step>(() => (initialRepo ? "fields" : "repo"))
    const [repoUrl, setRepoUrl] = useState(initialRepoUrl ?? "")
    const [repo, setRepo] = useState<RepoInfo | null>(initialRepo)
    const [releases, setReleases] = useState<GitHubRelease[]>([])
    const [fieldConfigs, setFieldConfigs] = useState(initialFieldConfigs)
    const [slugStrategy, setSlugStrategy] = useState<SlugStrategy>(initialSlugStrategy)
    const [status, setStatus] = useState<Status>("idle")
    const [errorMessage, setErrorMessage] = useState("")

    const isAllowedToSync = useIsAllowedTo(...SYNC_METHODS)
    const parsedRepo = useMemo(() => {
        try {
            return parseRepoInput(repoUrl)
        } catch {
            return null
        }
    }, [repoUrl])

    const isBusy = status === "fetching" || status === "syncing"
    const canSubmitRepo = Boolean(parsedRepo) && isAllowedToSync && !isBusy
    const canSyncFields = Boolean(repo) && isAllowedToSync && !isBusy

    useEffect(() => {
        void setCloseWarning(isBusy)

        return () => {
            if (isBusy) void setCloseWarning(false)
        }
    }, [isBusy])

    useLayoutEffect(() => {
        const isFieldStep = step === "fields"
        const measuredHeight = Math.ceil(screenRef.current?.getBoundingClientRect().height ?? 0)
        const height = isFieldStep ? 425 : measuredHeight || REPO_SCREEN_FALLBACK_HEIGHT

        void framer.showUI({
            width: isFieldStep ? 360 : 260,
            height,
            minWidth: isFieldStep ? 360 : undefined,
            minHeight: isFieldStep ? 425 : undefined,
            resizable: isFieldStep,
        })
    }, [status, step])

    const handleRepoSubmit = useCallback(
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            if (!canSubmitRepo || !parsedRepo) return

            const task = async () => {
                setStatus("fetching")
                setErrorMessage("")

                try {
                    const fetchedReleases = await fetchGitHubReleases(parsedRepo)
                    if (fetchedReleases.length === 0) {
                        throw new Error(`No releases found for ${parsedRepo.fullName}.`)
                    }

                    setRepo(parsedRepo)
                    setRepoUrl(parsedRepo.url)
                    setReleases(fetchedReleases)
                    setStep("fields")
                } catch (error) {
                    if (error instanceof FramerPluginClosedError) {
                        return
                    }

                    const message = error instanceof Error ? error.message : "Failed to fetch GitHub releases."
                    console.error(error)
                    framer.notify(message, { variant: "error" })
                } finally {
                    setStatus("idle")
                }
            }

            void task()
        },
        [canSubmitRepo, parsedRepo]
    )

    const handleFieldSubmit = useCallback(
        (event: FormEvent<HTMLFormElement>) => {
            event.preventDefault()
            if (!canSyncFields || !repo) return

            const task = async () => {
                setStatus("syncing")
                setErrorMessage("")

                try {
                    const releasesToSync = releases.length > 0 ? releases : await fetchGitHubReleases(repo)
                    if (releasesToSync.length === 0) {
                        throw new Error(`No releases found for ${repo.fullName}.`)
                    }

                    setReleases(releasesToSync)
                    const result = await syncReleaseData(collection, repo, releasesToSync, fieldConfigs, slugStrategy)
                    framer.closePlugin(`Synced ${result.releaseCount} GitHub releases.`, { variant: "success" })
                } catch (error) {
                    if (error instanceof FramerPluginClosedError) {
                        return
                    }

                    const message = error instanceof Error ? error.message : "Failed to sync GitHub releases."
                    console.error(error)
                    setStatus("error")
                    setErrorMessage(message)
                }
            }

            void task()
        },
        [canSyncFields, collection, fieldConfigs, releases, repo, slugStrategy]
    )

    const updateFieldName = useCallback((fieldId: ReleaseFieldConfig["id"], name: string) => {
        setFieldConfigs(configs => configs.map(config => (config.id === fieldId ? { ...config, name } : config)))
    }, [])

    const toggleField = useCallback((fieldId: ReleaseFieldConfig["id"]) => {
        if (fieldId === FIELD_IDS.title) return

        setFieldConfigs(configs =>
            configs.map(config => (config.id === fieldId ? { ...config, enabled: !config.enabled } : config))
        )
    }, [])

    if (step === "fields") {
        return (
            <main className="field-setup framer-hide-scrollbar" ref={screenRef}>
                <form onSubmit={handleFieldSubmit}>
                    <label className="slug-field" htmlFor="slugField">
                        Slug Field
                        <select
                            id="slugField"
                            value={slugStrategy}
                            disabled={isBusy}
                            onChange={event => setSlugStrategy(event.target.value as SlugStrategy)}
                        >
                            <option value="repository-tag">Repository + Tag</option>
                            <option value="repository-short-hash">Repository + Short Hash</option>
                        </select>
                    </label>

                    <div className="fields">
                        <span className="fields-column">Column</span>
                        <span>Field</span>
                        {fieldConfigs.map(config => (
                            <FieldConfigRow
                                key={config.id}
                                config={config}
                                disabled={isBusy}
                                onNameChange={updateFieldName}
                                onToggle={toggleField}
                            />
                        ))}
                    </div>

                    {status === "error" ? (
                        <div className="status-panel error-panel" role="alert">
                            <span>{errorMessage}</span>
                            <button type="button" onClick={() => setStatus("idle")}>
                                Try again
                            </button>
                        </div>
                    ) : null}

                    <footer className="field-footer">
                        <hr />
                        <button
                            type="submit"
                            disabled={isBusy || !isAllowedToSync}
                            title={isAllowedToSync ? undefined : "Insufficient permissions"}
                        >
                            {status === "syncing" ? <div className="framer-spinner" /> : "Import from GitHub"}
                        </button>
                    </footer>
                </form>
            </main>
        )
    }

    return (
        <main className="setup" ref={screenRef}>
            <Intro />
            <form onSubmit={handleRepoSubmit}>
                <label className="username-field" htmlFor="repoUrl">
                    <span className="visually-hidden">GitHub repository URL</span>
                    <div className="username-input repo-input">
                        <input
                            id="repoUrl"
                            name="repoUrl"
                            type="text"
                            value={repoUrl}
                            onChange={event => {
                                setRepoUrl(event.target.value)
                                setErrorMessage("")
                            }}
                            placeholder="github.com/framer/plugins"
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            disabled={isBusy}
                        />
                    </div>
                </label>

                <button
                    type="submit"
                    disabled={!canSubmitRepo}
                    title={isAllowedToSync ? undefined : "Insufficient permissions"}
                >
                    {status === "fetching" ? (
                        <div className="framer-spinner" />
                    ) : (
                        "Next"
                    )}
                </button>
            </form>
        </main>
    )
}

async function setCloseWarning(isEnabled: boolean) {
    try {
        await framer.setCloseWarning(isEnabled ? CLOSE_WARNING_MESSAGE : false)
    } catch (error) {
        if (error instanceof FramerPluginClosedError) return

        console.error(error)
    }
}

function parseInitialRepo(repoUrl: string | null): RepoInfo | null {
    if (!repoUrl) return null

    try {
        return parseRepoInput(repoUrl)
    } catch {
        return null
    }
}

interface FieldConfigRowProps {
    config: ReleaseFieldConfig
    disabled: boolean
    onNameChange: (fieldId: ReleaseFieldConfig["id"], name: string) => void
    onToggle: (fieldId: ReleaseFieldConfig["id"]) => void
}

function FieldConfigRow({ config, disabled, onNameChange, onToggle }: FieldConfigRowProps) {
    const canDisable = config.id !== FIELD_IDS.title

    return (
        <>
            <button
                type="button"
                className={`source-field ${config.enabled ? "" : "ignored"}`}
                onClick={() => onToggle(config.id)}
                disabled={disabled}
                aria-pressed={config.enabled}
                title={canDisable ? undefined : "Title is required"}
            >
                <span className="checkmark" aria-hidden="true">
                    {config.enabled ? "\u2713" : ""}
                </span>
                <span>{config.sourceName}</span>
            </button>
            <span className="map-arrow" aria-hidden="true">
                {"\u203A"}
            </span>
            <input
                type="text"
                disabled={disabled || !config.enabled}
                placeholder={config.sourceName}
                value={config.name}
                onChange={event => onNameChange(config.id, event.target.value)}
                onKeyDown={event => {
                    if (event.key === "Enter") {
                        event.preventDefault()
                    }
                }}
            />
        </>
    )
}

function Intro() {
    return (
        <header className="intro">
            <div className="logo">
                <img src="/logo.svg" width="30" height="30" alt="" />
            </div>
            <div className="content">
                <h2>GitHub Releases</h2>
                <p>Publish product updates from GitHub in minutes. Keep your Framer website in sync with any release.</p>
                <a href="https://docs.github.com/en/rest/releases/releases" target="_blank" rel="noreferrer">
                    Powered by GitHub Releases.
                </a>
            </div>
        </header>
    )
}
