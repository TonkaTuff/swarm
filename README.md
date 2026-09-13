# Swarm

Living things, drawn as dots. A murmuration of starlings that wheels and folds, a bait ball that spins and flashes, fireflies blinking over a meadow, bees round a swarm and in and out of a hive. Canvas 2D, no dependencies, one script.

Third of the TonkaTuff libraries, after [Ephemeris](https://github.com/TonkaTuff/ephemeris) (the sky) and [Coriolis](https://github.com/TonkaTuff/coriolis) (the weather). The dots are sized the same way, so all three sit together on a page.

## Use it

```html
<script src="https://cdn.jsdelivr.net/gh/TonkaTuff/swarm@v0.2.0/dist/swarm.min.js"></script>
<canvas class="swarm" width="300" height="200" data-swarm-body="starlings"></canvas>
```

Every `canvas.swarm` on the page mounts itself. Height sets the size; a wider canvas gives them room to roam. Add canvases later with `Swarm.register()`. One thing at a time: `dist/<name>.min.js` is the core plus that one.

## Things

| Family | Name | What marks it out |
|---|---|---|
| Murmurations | `starlings` | the classic: a cloud that folds and pours |
| | `rome` | the winter roosts over the Tiber, the biggest of all |
| | `gretna` | the Scottish border, where the shapes get wildest |
| | `brighton` | over the old pier at dusk, small and quick |
| Bait balls | `bait-ball` | a spinning sphere of fish; a predator passes and it opens, then closes |
| | `sardine-run` | bigger, faster, and the predators keep coming |
| | `anchovies` | small and tight and quick, blue in the light |
| Fireflies | `fireflies` | each on its own clock, drifting low over the grass |
| | `synchronous` | the Great Smoky Mountains kind: a wave of light passing through |
| | `blue-ghosts` | a steady blue-green glow, low and slow |
| Bees | `bee-swarm` | a cluster hanging from a branch, flyers looping round it |
| | `hive` | traffic in and out of the entrance, along a few lanes |
| | `hornets` | fewer, bigger, darker, faster |

## How it moves

Every bird keeps a fixed place in a ball. The ball wanders on a noisy path, its axes turn, it stretches along one and squashes along another, a shear folds it, and density waves roll through it. Fish keep their place in a thick spinning shell and flash outward when a predator passes. Fireflies wander on noise and blink on their own clocks, or a shared one. Bees fly hashed loops round a cluster, or lanes in and out of a hive. Nothing is remembered between frames: each one is a function of time, so a still frame, a loop and a scrub all work.

## Knobs

| attribute | value | what it does |
|---|---|---|
| `data-swarm-body` | name | one of the names above |
| `data-swarm-n` | number | how many birds at a 64px height, scaled up with size; 1800 by default |
| `data-swarm-reach` | number | the flock's size as a fraction of the height, 0.3 by default |
| `data-swarm-wave` | number | how strongly density waves roll through it, 1 by default |
| `data-swarm-tempo` | number | how fast it all happens, 1 by default |
| `data-swarm-spin` `-passes` | number | bait balls: how fast the ball turns (0.5), how often a predator comes through (1) |
| `data-swarm-sync` `-period` `-duty` | number | fireflies: blink together with a wave (0 or 1), seconds per blink (2.2), how long each flash lasts as a fraction (0.22) |
| `data-swarm-form` | `ghost` `hive` | blue ghosts glow instead of blinking; a hive is entrance traffic instead of a cluster |
| `data-swarm-ink` | `1` | monochrome dots that follow the page theme |
| `data-swarm-lite` | `1` | half the dots |
| `data-swarm-ground` | `1` | a dusk sky behind |
| `data-swarm-glow` | `0` | no soft glow, just the dots on a clear canvas |

Any `data-swarm-<knob>` reaches the mode as `opts.knob`, numbers parsed. Colours come from CSS custom properties, inherited: `--swarm-cold`, `--swarm-mid`, `--swarm-hot` for far to near, `--swarm-glow` for the light behind.

## JavaScript

```js
Swarm.body('rome', ctx, 200, t, dark, { w: 400, ground: true });
Swarm.GROUPS;   // { Murmurations: [...], "Bait balls": [...], Fireflies: [...], Bees: [...] }
```

## Build

`npm run build` writes `dist/swarm.min.js` and one `dist/<name>.min.js` per thing. `tools/verify.html` and `tools/verify-min.html`, served over http, check every bundle draws pixel-identical to the source.

MIT.
