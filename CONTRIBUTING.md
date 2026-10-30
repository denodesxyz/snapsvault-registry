# Contributing to the SnapsVault Registry

This repository takes one kind of contribution: a contributor file that lists snapshots on SnapsVault. The same flow updates or removes a listing. The [Contribute snapshots](https://docs.snapsvault.xyz/contributing/list-your-snapshots) page in the docs is the guide, with the feed example, the registry file example and the review checklist. The field rules are in [Feed format](https://docs.snapsvault.xyz/contributing/feed-format) and [Registry file](https://docs.snapsvault.xyz/contributing/registry-file). This file covers how the check and the review work.

## 1. Publish a feed

A feed is a JSON array served over HTTPS, one entry per current snapshot, one feed per chain ID and snapshot type. Every entry has `url`, `filename`, `size`, `creation_date`, `latest_block_height` and `sha256sum`. Nothing needs to be installed on the snapshot server. The docs show how to [generate a feed with a script](https://docs.snapsvault.xyz/contributing/list-your-snapshots#generate-a-feed-with-a-script).

The check applies these rules to the entries:

| Rule | What the check does |
|---|---|
| Required fields | Fails on an entry without a `url`, and on an entry with neither a `filename` nor a file name in the `url` path. Warns about a missing `size` or `sha256sum` and about a missing height on an `archive` entry, because the site shows "N/A" for them, and about a missing `creation_date`, because the Marketplace then uses the time of the sync. |
| Height | Every entry whose effective type is not exactly `archive` needs `latest_block_height` above `0`. A missing height is stored as `0`, which is accepted only for type `archive`, an archive that starts at genesis. |
| Type | The `type` in the registry file applies to every entry of the feed and wins over the `type` of the entry. An entry whose own `type` differs gets a warning. Without a registry `type`, the type of the newest entry is used and the check warns. One feed carries one type. |
| Size | A number with a unit, such as `"426Gb"`, `"1.2T"` or `"3.4 GiB"`. A bare number is read as GB and a digit string is sorted as bytes, so both get a warning. A bare value above `100000` is an error because it looks like bytes. |
| Compression label | The Marketplace derives it from the file name: `.lz4` is labelled lz4, `.gz` (including `.tar.gz`) is gzip, and every other name, such as `.tar.zst` or `.tar.bz2`, is tar. |
| Reachability | A HEAD request goes to the `url` of the newest entry of each feed. It follows redirects, waits up to 10 seconds and retries once after a network error or an HTTP 5xx or 429 answer. Any answer other than 2xx, and any network error, is a warning that names the status or the error. |

The feed itself is fetched with redirects refused, a 10 second timeout and a 1 MiB size limit.

## 2. Add a contributor file

1. Fork [denodesxyz/snapsvault-registry](https://github.com/denodesxyz/snapsvault-registry).
2. Add the file at `chains/celestia/<chain ID>/<contributor>.json`, one file per chain ID, for example `chains/celestia/celestia/mycontributor.json` for mainnet and `chains/celestia/mocha-5/mycontributor.json` for the `mocha-5` testnet. Use the same file name and the same `contributor` object in every chain ID folder.
3. Fill in the contributor profile and one `snapshots` element per feed, as in the [registry file example](https://docs.snapsvault.xyz/contributing/list-your-snapshots#registry-file-example).

`contributor.name` and each feed URL are required, and `type` should always be set (`pruned` or `archive`). `identity` is the 16-character Keybase key suffix and sets the avatar; `logoUrl` sets an image instead. `discord` is the contributor's Discord username, for example `bombermine`, not a server, an invite or a link.

A contributor name belongs to one contributor. Names are compared without case and extra spaces. A name that an existing contributor already uses is accepted only in a file with the same file name as the files of that contributor and with an identical `contributor` object, so a contributor can appear in several chain ID folders. Any other use of the name is an error that names the existing file. A feed URL that another contributor file already lists is an error as well. The chain ID folders that exist are the chain IDs SnapsVault lists. To request a new one, open an issue.

## 3. Check the file (optional)

The check runs automatically on every pull request (step 4), so this step is optional. A local run is for the contributor's own machine, not the snapshot server. It needs Node.js 22.18 or later and nothing else:

```sh
node scripts/validate.mjs chains/celestia/celestia/mycontributor.json
```

It reads the file, fetches every feed it lists and applies the Marketplace rules plus the stricter rules above. Each problem names the field, the value found, what is expected and what the Marketplace does with it:

```
FAIL  chains/celestia/celestia/mycontributor.json  (1 error)
      snapshots[0] feed https://snapshots.mycontributor.example/celestia/index.json: 2 entries
  error   snapshots[0] entry 2 of 2 (celestia_15093000.tar.lz4) creation_date "2026-10-19 09:37": creation_date is not an ISO 8601 date with a timezone
          expected: an ISO 8601 date and time with Z or an offset, for example "2026-10-19T09:37:14Z", between 2019-01-01 and one day from now
          effect:   the Marketplace skips this entry
```

Errors fail the check. Warnings do not fail it. They point at data the Marketplace shows as "N/A" (a missing `size` or `sha256sum`, or a missing `latest_block_height` on an `archive` entry), at a missing `creation_date` (the Marketplace uses the time of the sync), at a value the Marketplace reads differently from what was written (a size without a unit, an entry type that differs from the registry type) and at an archive that does not answer the reachability request.

## 4. Open a pull request

Open a pull request from the fork. The template asks for the contributor name, the feed URLs and the snapshot types they cover, and holds the checklist the review uses.

The **Validate registry** check runs on every pull request and is a required check: a pull request is merged only when it passes. It runs the validator of the base branch and checks only the files the pull request adds or changes:

- the path is `chains/celestia/<chain ID>/<contributor>.json` in an existing chain ID folder, with a valid file name; any added or changed `.json` file outside `chains/` is an error
- the contributor name and the feed URLs do not belong to another contributor
- the file has the fields and types the Marketplace reads
- every feed answers over HTTPS without redirects, within 10 seconds and under 1 MiB, and is a JSON array
- every feed entry passes the Marketplace rules for URLs, file names, size, height, date, SHA256, type, period and `tx_index`, and the height and size rules above

The result is shown on the pull request and on the changed file. A red check lists every problem in the job log.

## 5. Review and merge

The SnapsVault team, the code owner of `chains/`, `scripts/`, `test/` and `.github/`, reviews the file against the checklist. A pull request is merged after a code owner approves it and the **Validate registry** check passes. The sync reads the registry and every feed every 2 minutes, so the listing appears on the [marketplace](https://celestia.snapsvault.xyz) and through the SnapsOS CLI and the REST API within minutes of the merge. After every push to `main` the check runs again on all contributor files. On `main`, a feed that cannot be reached because of a network error or a timeout is a warning, so an outage at a contributor does not turn the branch red; on a pull request it is an error.

## Updating or removing a listing

Changes to the profile, a feed URL, the type or the period go through a pull request that edits the contributor file. A contributor that is already listed edits its existing file and replaces the feed URL there instead of adding a new file. A pull request that deletes the file removes the contributor, and its snapshots leave the Marketplace at the next sync. Changes inside a feed need no pull request: the sync picks them up on its own.

## Reporting a problem

To report a listing that is missing, out of date or wrong, open an issue with the **Listing problem** template. For questions, use [Telegram](https://t.me/goldzn) or the docs [Feedback](https://docs.snapsvault.xyz/contributing/feedback) page. Security issues are reported as described in [SECURITY.md](SECURITY.md).

## Changes to the check

Changes to `scripts/validate.mjs` keep it in line with the Marketplace rules. `scripts/`, `test/` and `.github/` have code owners. `test/parity.test.mjs` runs both implementations on the same inputs. It imports the app's `src/lib/validation/feed.ts` from [denodesxyz/snapsvault](https://github.com/denodesxyz/snapsvault), given by its path in `FEED_TS`. Without `FEED_TS` its tests are skipped, so the **Validate registry** check, which has no copy of the app, skips them. A change to the check must pass the parity test locally, with a checkout of the app next to this repository:

```sh
FEED_TS=../snapsvault/src/lib/validation/feed.ts node --test test/parity.test.mjs
node --test test/*.test.mjs
```

## License

Contributions are licensed under the [Apache License 2.0](LICENSE).
