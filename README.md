# GitHub Releases

A Framer CMS plugin that turns public GitHub releases into a plugin-managed CMS collection for changelog, release notes, and product updates pages.

![GitHub Releases plugin preview](assets/GitHub%20Releases%20-%20Asset%201.png)

The plugin uses GitHub's public REST API at `https://api.github.com/repos/{owner}/{repo}/releases`. It does not use OAuth, API keys, analytics, or any storage outside the managed CMS collection and its collection-scoped plugin data.

## Install

```bash
npm install
npm run dev
```

Then open Framer, add/open this development plugin, and configure it from the CMS managed collection flow. Use a collection named `Releases` for the intended setup.

## Use

1. Open the plugin in `configureManagedCollection` mode.
2. Enter a public GitHub repository URL, such as `github.com/framer/plugins`.
3. Click `Next`.
4. Confirm the slug format and CMS field names.
5. Click `Import from GitHub`.
6. The plugin fetches releases, configures the CMS fields, stores the repo and field settings on the managed collection, and upserts the latest releases.
7. Future runs in `syncManagedCollection` mode read the stored settings and sync in the background.

The plugin closes automatically after a successful import and shows a toast with the synced release count.

## Synced Fields

Before syncing, you can choose which fields to create and rename them to match your site.

The plugin configures these stable field IDs:

| Field ID           | Name             | Type          |
| ------------------ | ---------------- | ------------- |
| `title`            | Title            | string        |
| `tag`              | Tag              | string        |
| `summary`          | Summary          | string        |
| `body`             | Body             | formattedText |
| `published_at`     | Published At     | date          |
| `is_latest`        | Is Latest        | boolean       |
| `is_prerelease`    | Is Prerelease    | boolean       |
| `downloads`        | Downloads        | formattedText |
| `total_downloads`  | Total Downloads  | number        |
| `discussion_url`   | Discussion URL   | link          |
| `source_zip_url`   | Source ZIP URL   | link          |
| `source_tar_url`   | Source TAR URL   | link          |
| `compare_url`      | Compare URL      | link          |
| `github_url`       | GitHub URL       | link          |
| `author`           | Author           | string        |
| `author_avatar`    | Author Avatar    | image         |
| `target_commitish` | Target Commitish | string        |
| `is_immutable`     | Is Immutable     | boolean       |

The configure screen lets you rename fields and disable optional fields. Field types are fixed by the GitHub release schema, matching the CMS starter mapping pattern. Field IDs stay stable so repeat syncs update the same CMS fields.

`summary` is a short plain-text excerpt of the release notes. `downloads` contains links to uploaded assets, with any available size, download count, and digest. `total_downloads` sums the asset download counts. GitHub only provides `discussion_url` when a discussion is linked to the release. Target Commitish and Is Immutable are available but disabled by default. Collections configured before these fields were added keep their existing field choices until you enable the new fields in the configure screen.

## Slugs

Item IDs use `release.id`. The configure screen supports these slug formats:

- `Repository + Tag`, for example `acme/product` with tag `v1.2.3` becomes `product-v1.2.3`.
- `Repository + Short Hash`, for example `product-a1b2c3`.

The short hash is deterministic from the repository and GitHub release ID, so URLs stay stable across re-syncs.

## Mirror Behavior

GitHub's releases API returns the releases currently available for the repository. This plugin mirrors that source:

- First sync imports the releases currently returned by GitHub.
- Later syncs upsert by GitHub `release.id`, so existing items update instead of duplicating.
- New releases are added.
- Releases that no longer appear in the GitHub API response are removed from the managed collection.
- The plugin follows every GitHub pagination link before changing the collection. A failed or incomplete fetch does not remove older items.

Draft releases are normally not returned for public unauthenticated API requests. If GitHub returns a draft release, the plugin marks the CMS item as draft.
An empty release list stops the sync without removing the existing collection items.

## Markdown

Release notes are parsed as GitHub-flavored Markdown and sanitized before writing `body` as formatted text.

## Errors

The UI shows friendly errors for:

- Missing or invalid GitHub repository URLs
- Private or unreadable repositories
- Repositories with no releases
- GitHub API rate limits
- GitHub requests that do not respond within 20 seconds
- Unexpected GitHub API responses

Unauthenticated GitHub API rate limits are acceptable for manual sync, but repeated heavy usage can hit GitHub's limit.

## Scripts

```bash
npm run dev
npm run check
npm run build
npm run pack
node --test tests/github.test.cjs
```
