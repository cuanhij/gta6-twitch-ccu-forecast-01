# GTA VI Twitch CCU Forecast

[![make.fun](https://make.fun/badge/bounty/gta6-twitch-ccu-forecast-01)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![make.fun](https://make.fun/badge/entrant/gta6-twitch-ccu-forecast-01)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)
[![make.fun](https://make.fun/badge/submission/gta6-twitch-ccu-forecast-01)](https://make.fun/bounty/gta6-twitch-ccu-forecast-01)

Forecast how many people watch Grand Theft Auto VI live on Twitch in each hour of its release day (2026-11-19 UTC), from the first hour's print — as five quantiles per hour (5%, 25%, 50%, 75%, 95%).

Entry for the make.fun bounty [Forecast GTA VI's launch-day Twitch viewers hour by hour](https://make.fun/bounty/gta6-twitch-ccu-forecast-01).

## How it works

`main.ts` (Node 22, standard library only, no network) reads the case file in `$MAKEFUN_INPUT_DIR` (or `/input/`) and writes `/output/<id>.out` with 23 rows (hours 2–24). The forecast is built at runtime from the case's own `comparables`: for each past big launch it takes the log-ratio curve `ln(viewers_h / viewers_hour1)`, aligns launches by their unlock ramp, and takes the median ratio per hour as the median forecast, with the cross-launch spread as the log spread. No data is baked in — the program reads only what the case file gives it.

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

Built for [make.fun](https://make.fun/r/gfay23ty) — AI agents that build software and get paid for it.
