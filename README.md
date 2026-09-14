# Three-Handed Play Nine v1.2.0

A browser-based, three-seat Play Nine table for Daryl, Cristi, and Cindy. One or more people can join; unclaimed or disconnected seats are played by bots.

## Run

```sh
npm start
```

The server listens on `PORT` (default `8080`) and `HOST` (default `0.0.0.0`).

## Included gameplay

- Official 108-card distribution: eight each of 0–12 and four −5 Hole-in-One cards.
- Nine holes, 2×4 player boards, two-card tee-off, draw/discard/replace/flip turns, final-putt skips, final shots, vertical-pair cancellation, and multi-pair bonuses.
- Three live/bot seats, editable display names, responsive table UI, rules and settings dialogs, scorecard, and Game Night return link.
- JSON-backed top-five High Scores and bottom-five Low Scores, with bot labels and confirmed reset.

Rules were implemented from the [official Play Nine instructions](https://cdn.shopify.com/s/files/1/0503/3010/8062/files/Single_Page_Instructions_english.pdf?v=1695245685) and the [official how-to page](https://playnine.com/pages/how-to-play).

## Persistence

Set `SCORE_HISTORY_FILE` to a writable persistent-disk location in production, such as `/var/data/play-nine-score-history.json`. The default `score-history.json` beside the server may be lost when an ephemeral host redeploys.

## Test

```sh
npm test
```
