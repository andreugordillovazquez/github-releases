const assert = require("node:assert/strict")
const test = require("node:test")
const jiti = require("jiti")(process.cwd() + "/")
const { createDefaultFieldConfigs, parseFieldConfigs } = jiti("./src/fields.ts")
const { fetchGitHubReleases, parseRepoInput, syncReleaseData, syncReleases } = jiti("./src/github.ts")

const repo = parseRepoInput("https://github.com/example/project")

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
