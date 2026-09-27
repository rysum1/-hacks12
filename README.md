# Pygmalion's Unexceptionable 100% Authentic Sculpting Experience

Carve a block of stone in the browser with a real chisel, hammer, sandpaper, and paintbrush,
then publish what you made to a shared gallery for everyone to see.

**Live:** https://pygmalion-gallery-btg9u.ondigitalocean.app/studio.html
**Demo:** 

## How it works

The stone block isn't a 3D model you push and pull — it's a 3D grid of numbers (a *signed
distance field*), where each point in space stores roughly "how far is this point from the
surface, and am I inside the stone or outside it." Carving and adding material are just simple
math operations on that grid. Every time it changes, the visible surface is regenerated from
scratch with an algorithm called **Surface Nets**, which walks the grid and builds a mesh
wherever the numbers cross from "inside" to "outside." There's no mesh to break or glitch —
just numbers, re-surfaced on demand.

A chisel strike doesn't just dig a groove. It computes one of **five physically different chip
shapes** (a wedge, a block, a shard, a flake, or a splinter), and that same shape is both the
hole left behind and the piece of debris that breaks off. Which shape you get depends on the
angle of the strike: hit it straight-on and you tend to knock out a wedge or block; hit it at a
glancing angle and you shave off a thin flake or splinter, the way striking real stone would
behave.

Broken pieces can also genuinely fall off. After every strike, the engine checks — via a flood
fill through the solid part of the grid — whether every remaining chunk of stone is still
connected back to the base. If a piece isn't connected to anything anymore, it gets cut loose
and falls, with its own basic tumbling physics.

Paint is stored on that same 3D grid, right alongside the stone data, rather than drawn onto
the final surface. That's why carving through a painted area exposes bare stone underneath: the
paint for that spot was never there in the grid to begin with.

Since the surface is rebuilt constantly, it never has fixed UV coordinates, so the stone photo
texture is applied with **triplanar mapping** — projected from three directions and blended by
which way each part of the surface faces — through a small custom shader. The same photo's
brightness doubles as a bump map, so carved edges and chips catch the light like real rock.

The 3D tool models you see in your hand (chisels, hammer, sandpaper, paintbrush) aren't
separately modeled — they're generated automatically by reading the flat pixel-art icon for
each tool and extruding every colored pixel into a tiny cube. Swap in new pixel art (see
"Swapping in your tool art" below) and you get a new 3D tool for free.

Saved sculptures use a small custom file format (`.sclp`): the distance field is compressed to
one byte per grid point (only the area near the surface matters) and gzip-compressed on top,
which is why a sculpture file is typically just 5–60 KB despite the underlying grid holding
well over 100,000 points.

### The gallery

There are no user accounts. Each browser generates a random private key the first time you
publish, and only a one-way hash of that key is ever sent to the server — enough to prove later
that "this browser published this piece" (so you see a Delete button on your own work) without
storing anything that identifies you. Likes and reports are tracked the same way, one per
browser per sculpture; three reports auto-hide a piece. Remixing opens the studio pre-loaded
with someone else's sculpture data, and a published remix links back to the original.

Sculpture files and thumbnails live in **DigitalOcean Spaces**; the gallery metadata (titles,
likes, remix lineage) lives in **DigitalOcean Managed PostgreSQL**; both are served through a
small Node/Express API running on **DigitalOcean App Platform**. If that backend isn't reachable
(for example, running the static files with no server), the app falls back to a local,
browser-only demo gallery automatically, so the studio always works even offline.

## Project layout

```
index.html        Gallery (home page): browse, search, like, view in 3D, remix
studio.html       The sculpting studio, with "Publish to gallery"
js/engine.js      The stone block, tools, meshing, and the .sclp save format
js/stone.js       Stone material (photo texture, paint, bump)
js/viewer.js      3D viewer used by the gallery
js/store.js       Gallery storage: DigitalOcean API, or browser demo mode
server/index.js   Node API for gallery data and Spaces file storage
server/schema.sql PostgreSQL schema
assets/           Stone texture, tool art, fonts
```

## Running it locally

```
npm install
npm start
```

Then open `http://localhost:3001/`. Without any DigitalOcean environment variables set, it
automatically runs in demo mode (a local, browser-only gallery), so it works out of the box.

To connect a real shared gallery, set `DATABASE_URL`, `DATABASE_CA_CERT`, and the `SPACES_*`
variables shown in `.env.example`, then run `npm run db:setup` once to create the tables before
starting the server.

## Swapping in your tool art

See `TOOL_ART` in `studio.html`: replace an image with your own pixel art (tool on the
diagonal, working end toward the top-right, transparent background). The toolbar icon and the
3D model in your hand are both built from it automatically.
