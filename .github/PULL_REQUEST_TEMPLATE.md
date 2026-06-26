## Summary

## Changes

-

## Test plan

- [ ] `node --test` green (incl. golden filter_complex snapshots)
- [ ] If the filter graph changed: goldens regenerated deliberately (`GOLDEN=1 node --test`) and the diff is the intended change
- [ ] If a new move: **rendered against real media** (snapshots prove the graph is *stable*, not that ffmpeg *accepts* it)

## Checklist

- [ ] Reads like the surrounding code (comment density, naming, idiom)
- [ ] Schema + SKILL/README updated if the pack contract changed
