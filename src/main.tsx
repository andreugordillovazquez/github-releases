import "@framer/plugin/framer.css"

import { FramerPluginClosedError, framer } from "@framer/plugin"
import React from "react"
import ReactDOM from "react-dom/client"
import { App } from "./App"
import { parseFieldConfigs } from "./fields"
import { PLUGIN_DATA_KEYS, SYNC_METHODS, parseSlugStrategy, syncReleases, type SlugStrategy } from "./github"

const collection = await framer.getActiveManagedCollection()

if (!collection) {
    framer.closePlugin("Open this plugin from a managed CMS collection.", { variant: "error" })
}

const repoUrl = await collection.getPluginData(PLUGIN_DATA_KEYS.REPO_URL)
const fieldConfigs = parseFieldConfigs(await collection.getPluginData(PLUGIN_DATA_KEYS.FIELD_CONFIGS))
const slugStrategy = parseSlugStrategy(await collection.getPluginData(PLUGIN_DATA_KEYS.SLUG_STRATEGY))

if (framer.mode === "syncManagedCollection") {
    if (repoUrl) {
        await syncExistingCollection(repoUrl, fieldConfigs, slugStrategy)
    } else {
        framer.closePlugin("Configure a GitHub repository before syncing.", { variant: "error" })
    }
}

const root = document.getElementById("root")
if (!root) {
    throw new Error("Root element not found")
}

ReactDOM.createRoot(root).render(
    <React.StrictMode>
        <App
            collection={collection}
            initialRepoUrl={repoUrl}
            initialFieldConfigs={fieldConfigs}
            initialSlugStrategy={slugStrategy}
        />
    </React.StrictMode>
)

async function syncExistingCollection(
    repoUrl: string,
    fieldConfigs: Parameters<typeof syncReleases>[2],
    slugStrategy: SlugStrategy
) {
    if (!framer.isAllowedTo(...SYNC_METHODS)) {
        framer.closePlugin("You do not have permission to sync this collection.", { variant: "error" })
    }

    await setSyncCloseWarning(true)

    try {
        const result = await syncReleases(collection, repoUrl, fieldConfigs, slugStrategy)
        await setSyncCloseWarning(false)
        framer.closePlugin(`Synced ${result.releaseCount} GitHub releases.`, { variant: "success" })
    } catch (error) {
        if (error instanceof FramerPluginClosedError) {
            return
        }

        console.error(error)
        await setSyncCloseWarning(false)
        framer.closePlugin("Could not sync GitHub releases. Reconfigure the collection and try again.", {
            variant: "error",
        })
    }
}

async function setSyncCloseWarning(isEnabled: boolean) {
    try {
        await framer.setCloseWarning(isEnabled ? "GitHub releases are still syncing. Close anyway?" : false)
    } catch (error) {
        if (error instanceof FramerPluginClosedError) return

        console.error(error)
    }
}
