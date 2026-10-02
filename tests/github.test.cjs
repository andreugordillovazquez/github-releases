const assert = require("node:assert/strict")
const { before, test } = require("node:test")
const jiti = require("jiti")(process.cwd() + "/")
const { createDefaultFieldConfigs, parseFieldConfigs } = jiti("./src/fields.ts")
let fetchGitHubReleases
let parseRepoInput
let syncReleaseData
let syncReleases
let ManagedCollectionWriteError
let FramerPluginError
let repo

before(async () => {
    const github = await jiti.import("./src/github.ts")
    const framer = await import("@framer/plugin")
    fetchGitHubReleases = github.fetchGitHubReleases
    parseRepoInput = github.parseRepoInput
    syncReleaseData = github.syncReleaseData
    syncReleases = github.syncReleases
    ManagedCollectionWriteError = github.ManagedCollectionWriteError
    FramerPluginError = framer.FramerPluginError
    repo = parseRepoInput("https://github.com/example/project")
})

test("saved collections keep new fields disabled until configured", () => {
    const legacyFields = createDefaultFieldConfigs()
        .filter(field =>
            [
                "title",
                "tag",
                "body",
                "published_at",
                "is_latest",
                "is_prerelease",
                "compare_url",
                "github_url",
                "author",
                "author_avatar",
            ].includes(field.id)
        )
        .map(field => [field.id, field.name, field.enabled ? 1 : 0])
    const configs = parseFieldConfigs(JSON.stringify({ version: 1, fields: legacyFields }))

    assert.equal(configs.find(field => field.id === "body").enabled, true)
    assert.equal(configs.find(field => field.id === "downloads").enabled, false)
    assert.equal(configs.find(field => field.id === "summary").enabled, false)
})

test("fetches release pages beyond the former ten-page limit", async () => {
    const originalFetch = global.fetch
    const requests = []
    global.fetch = async url => {
        requests.push(url)
        const page = Number(new URL(url).searchParams.get("page") ?? 1)
        const next =
            page < 11
                ? `<https://api.github.com/repositories/123/releases?per_page=100&page=${page + 1}>; rel="next"`
                : ""
        return new Response(JSON.stringify([{ id: page }]), { headers: next ? { Link: next } : {} })
    }

    try {
        const releases = await fetchGitHubReleases(repo)
        assert.equal(releases.length, 11)
        assert.equal(requests.length, 11)
        assert.match(requests[1], /\/repositories\/123\/releases/)
        assert.equal(releases.at(-1).id, 11)
    } finally {
        global.fetch = originalFetch
    }
})

test("a failed later page leaves the collection untouched", async () => {
    const originalFetch = global.fetch
    let requests = 0
    global.fetch = async () => {
        requests += 1
        if (requests === 1) {
            return new Response(JSON.stringify([{ id: 1 }]), {
                headers: {
                    Link: '<https://api.github.com/repos/example/project/releases?per_page=100&page=2>; rel="next"',
                },
            })
        }
        return new Response(JSON.stringify({ message: "Rate limited" }), { status: 403 })
    }
    const calls = []
    const collection = {
        setFields: () => calls.push("setFields"),
        getItemIds: () => calls.push("getItemIds"),
        addItems: () => calls.push("addItems"),
        removeItems: () => calls.push("removeItems"),
        setPluginData: () => calls.push("setPluginData"),
    }

    try {
        await assert.rejects(syncReleases(collection, repo.url), /GitHub returned 403/)
        assert.deepEqual(calls, [])
    } finally {
        global.fetch = originalFetch
    }
})

test("a stalled GitHub request times out before changing the collection", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    const originalFetch = global.fetch
    const calls = []
    let requestAborted = false
    global.fetch = (_url, { signal }) =>
        new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => {
                requestAborted = true
                reject(new DOMException("The operation was aborted.", "AbortError"))
            })
        })
    const collection = {
        setFields: () => calls.push("setFields"),
        getItemIds: () => calls.push("getItemIds"),
        addItems: () => calls.push("addItems"),
        removeItems: () => calls.push("removeItems"),
        setPluginData: () => calls.push("setPluginData"),
    }

    try {
        const sync = syncReleases(collection, repo.url)
        t.mock.timers.tick(20_000)
        await assert.rejects(sync, /GitHub did not respond in time/)
        assert.equal(requestAborted, true)
        assert.deepEqual(calls, [])
    } finally {
        global.fetch = originalFetch
        t.mock.timers.reset()
    }
})

test("an empty release list cannot clear a collection", async () => {
    const calls = []
    const collection = {
        setFields: () => calls.push("setFields"),
        getItemIds: () => calls.push("getItemIds"),
        addItems: () => calls.push("addItems"),
        removeItems: () => calls.push("removeItems"),
        setPluginData: () => calls.push("setPluginData"),
    }

    await assert.rejects(syncReleaseData(collection, repo, []), /No releases found/)
    assert.deepEqual(calls, [])
})

for (const failedOperation of ["setFields", "addItems", "removeItems", "setPluginData"]) {
    test(`a permission failure in ${failedOperation} identifies the failed write and stops sync`, async () => {
        const calls = []
        const denial = new FramerPluginError("Insufficient permissions")
        const record = (operation, value) => {
            calls.push(operation)
            if (operation === failedOperation) throw denial
            return value
        }
        const collection = {
            setFields: () => record("setFields"),
            getItemIds: () => record("getItemIds", ["old-release"]),
            addItems: () => record("addItems"),
            removeItems: () => record("removeItems"),
            setPluginData: () => record("setPluginData"),
        }

        await assert.rejects(syncReleaseData(collection, repo, [{ id: 1, tag_name: "v1" }]), error => {
            assert.ok(error instanceof ManagedCollectionWriteError)
            assert.equal(error.cause, denial)
            assert.match(error.message, /Framer denied permission/)
            assert.match(error.message, /Check your CMS access/)
            return true
        })
        assert.equal(calls.at(-1), failedOperation)
        assert.equal(calls.filter(call => call === failedOperation).length, 1)
    })
}

test("a non-permission collection API failure identifies the failed operation", async () => {
    const collection = {
        setFields: () => {
            throw new Error("API unavailable")
        },
    }

    await assert.rejects(syncReleaseData(collection, repo, [{ id: 1, tag_name: "v1" }]), error => {
        assert.ok(error instanceof ManagedCollectionWriteError)
        assert.match(error.message, /Could not update collection fields/)
        assert.equal(error.cause.message, "API unavailable")
        return true
    })
})
