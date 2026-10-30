## Contributor

- Contributor name:
- Registry file(s):
- Feed URL(s) and the snapshot type each one covers:

## Checklist

Full rules: https://docs.snapsvault.xyz/contributing/list-your-snapshots

- [ ] The file is at `chains/<network>/<chain ID>/<contributor>.json`, one file per chain ID.
- [ ] The feed URL returns a JSON array, smaller than 1 MiB, within 10 seconds and without redirects.
- [ ] Every URL (feed and downloads) starts with `https://`, uses a public DNS name, and has no port, credentials or IP address.
- [ ] The contributor name and every feed URL are not used by another contributor.
- [ ] Every entry has `url`, `filename`, `size`, `creation_date`, `latest_block_height` and `sha256sum`. The height is above `0`; height `0` is only for an `archive` that starts at genesis.
- [ ] `size` has a unit such as `426Gb`. A bare number is read as GB, and a bare value above `100000` is an error.
- [ ] The registry `type` matches the feed. It wins over the `type` of each entry.
- [ ] The newest archive answers a HEAD request over HTTPS. The check warns when it does not.
- [ ] The `period` value matches how often the feed really updates.
- [ ] A stable latest URL such as `latest.tar.lz4` comes with a `latest_block_height` that changes for each new archive, so history is kept.
- [ ] `node scripts/validate.mjs chains/<network>/<chain ID>/<contributor>.json` passes locally, or the **Validate registry** check passes on this pull request.
