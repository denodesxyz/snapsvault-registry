---
name: Listing problem
about: A listing is missing, out of date or shows wrong data
title: "Listing problem: "
---

## Listing

- Contributor name:
- Registry file: `chains/<network>/<chain ID>/<contributor>.json`
- Feed URL:
- Marketplace or REST API link that shows the problem:

## What happens

<!-- For example: the contributor does not appear, a snapshot is older than the feed, the height or size is wrong. -->

## What is expected

## Checks done

- [ ] The feed URL returns a JSON array over HTTPS without redirects (`curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' <feed URL>` prints `200` and no redirect).
- [ ] `node scripts/validate.mjs <registry file>` passes on the current `main`.
- [ ] More than 2 minutes have passed since the last change to the feed or the registry file.
