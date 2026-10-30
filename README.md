# SnapsVault Registry

The list of snapshot contributors behind [SnapsVault](https://snapsvault.xyz). Each contributor file names one contributor and points at the JSON feeds of that contributor's snapshots. Some contributor files point at a feed hosted by SnapsVault. It is replaced when the contributor submits its own feed. The [Marketplace](https://celestia.snapsvault.xyz) reads this repository and every feed it lists every 2 minutes. The SnapsOS CLI and the REST API serve the same data, so a merged change shows up within minutes.

**Links:** [Website](https://snapsvault.xyz) · [Marketplace](https://celestia.snapsvault.xyz) · [Docs](https://docs.snapsvault.xyz) · [SnapsVault source](https://github.com/denodesxyz/snapsvault)

## Add your snapshots

Contributors add their snapshots with one pull request to this repository.

1. Publish a feed over HTTPS.
2. Fork this repository and add `chains/celestia/<chain ID>/<contributor>.json`.
3. Open a pull request. The **Validate registry** check reads the file and its feeds with the Marketplace rules and a few stricter ones.
4. The SnapsVault team reviews and merges it. The listing appears on the next sync.

The steps, the feed format and the review checklist are on the [Contribute snapshots](https://docs.snapsvault.xyz/contributing/list-your-snapshots) page. The rules for each file are in [Feed format](https://docs.snapsvault.xyz/contributing/feed-format) and [Registry file](https://docs.snapsvault.xyz/contributing/registry-file). [CONTRIBUTING.md](CONTRIBUTING.md) explains the check.

## Layout

```
chains/
  celestia/                  network
    celestia/                chain ID (mainnet)
      deNodes.json           one file per contributor and chain ID
      polkachu.json
    mocha-4/                 chain ID (testnet)
    mocha-5/                 chain ID (testnet)
scripts/validate.mjs         the check that runs on every pull request
test/                        tests for the check
```

A contributor file looks like this:

```json
{
  "contributor": {
    "name": "deNodes",
    "website": "https://denodes.io",
    "identity": "C89053F92B77D8C0"
  },
  "snapshots": [
    {
      "snapshots": "https://celestia-mainnet-snap.denodes.xyz/index.json",
      "type": "pruned",
      "period": "4h",
      "tx_index": false
    }
  ]
}
```

`contributor` is the profile shown in the Marketplace. Each element of `snapshots` is one feed: the URL of a JSON array with one entry per current snapshot, its snapshot type and how often it updates. Every feed entry has six fields: `url`, `filename`, `size`, `creation_date`, `latest_block_height` and `sha256sum`.

## Check a file locally

The check runs on every pull request, so a local run is optional. It needs Node.js 22.18 or later and nothing else.

```sh
node scripts/validate.mjs chains/celestia/celestia/<contributor>.json
```

Without arguments it checks every contributor file. Errors name the field, the value found and what is expected. Warnings do not fail the check.

## Help

Ask on [Telegram](https://t.me/goldzn), use the docs [Feedback](https://docs.snapsvault.xyz/contributing/feedback) page, or open an issue here with the **Listing problem** template. Security issues are reported as described in [SECURITY.md](SECURITY.md).

## License

[Apache License 2.0](LICENSE)
