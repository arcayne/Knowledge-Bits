# Run notes

- The user selected an adaptive four-to-eight-card range.
- The implementation records the selected count and rationale in the generated series.
- Contract validation rejects fewer than four cards, more than eight cards, non-contiguous sequence numbers, asset-kind/sequence mismatches, duplicate title/body pairs, and incorrect canvas dimensions.
- Worker validation rejects claim references that are not present in the checked claim inventory.
- The first use case routes to a committed four-card fixture. This proves the asset-stage shape without claiming that the images are production outputs.
- Next implementation boundary: create a Joan checked-content payload with claims and add a production image provider that returns 4–8 portrait assets with output checksums.
