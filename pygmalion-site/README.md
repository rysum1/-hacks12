# Pygmalion's 100% Authentic Sculpting Experience

Carve a block of stone in the browser, publish it, and browse what everyone else made.

```
index.html        Gallery (home page): browse, search, like, view in 3D, remix
studio.html       The sculpting studio, with "Publish to gallery"
js/engine.js      The stone block, tools, meshing, and the .sclp save format
js/stone.js       Stone material (photo texture, paint, bump)
js/viewer.js      3D viewer used by the gallery
js/store.js       Gallery storage: Supabase online, or demo mode in the browser
js/config.js      <- your Supabase keys go here
assets/stone.jpg  Stone texture
supabase/schema.sql  One-time database setup
```

## 1. Run it on your computer

The site uses separate JavaScript files, so it has to be served over http
(double-clicking the HTML files won't work). From this folder, run one of:

```
npx serve .
python3 -m http.server 8000
```

Then open the address it prints. Without Supabase keys the gallery runs in
**demo mode**: everything works, but sculptures are saved only in that browser.

## 2. Connect the online gallery (Supabase, free tier)

1. Sign up at supabase.com and create a new project (pick a region near you;
   save the database password somewhere safe).
2. In the project: **SQL Editor → New query**, paste all of
   `supabase/schema.sql`, click **Run**. It creates the table, the security
   rules and the file storage. It's safe to run again.
3. **Project Settings → API**: copy the **Project URL** and the **anon public**
   key into `js/config.js`.
4. Reload the gallery - the yellow "Demo mode" note disappears.

The anon key is designed to be public. What keeps the data safe is the rules
in `schema.sql`: visitors can read and publish, but can't edit or delete
anything directly; likes, reports and deletes only go through dedicated
functions.

## 3. Put it on the web with your domain

Any static host works; these are free:

- **Netlify** - drag this folder onto app.netlify.com/drop, or connect your Git repo.
- **Cloudflare Pages** - connect the Git repo; no build command, output folder `/`.
- **Vercel** - import the Git repo; framework preset "Other".

Then connect the domain: in the host's dashboard choose **Domains → Add
custom domain**, and add the DNS records it shows you at your domain
registrar (usually one `CNAME`, or an `A` record for the bare domain). HTTPS
is set up automatically.

## How the gallery works

- **No accounts.** People publish with a display name. Each browser keeps a
  private random key; only its SHA-256 hash is stored with the sculpture, so
  that browser (and only it) sees a **Delete** button on its own work.
  Clearing browser data loses that key.
- **Likes** are one per sculpture per browser (remembered in the browser).
- **Reports**: 3 reports hide a sculpture. To bring one back or remove it for
  good, edit the `sculptures` table in Supabase → Table Editor (`hidden`).
- **Remix** opens `studio.html?remix=<id>`; the published result links back to
  the original.
- **Links** like `index.html#sculpture=<id>` open a sculpture directly
  ("Copy link" in the viewer).
- **Files**: each sculpture is a `.sclp` file (typically 5-60 KB) plus a
  512 px WebP picture, in the public `sculptures` storage bucket. The free
  tier's 1 GB storage fits tens of thousands.

### Known limits (fine for a hackathon, worth revisiting later)

- There's no rate limiting, so a determined person could spam uploads or likes.
  Supabase's paid tiers and Cloudflare offer rate limiting if you need it.
- Deleted or hidden sculptures stay in storage (they're just not listed).
- Moderation is only the report threshold; check the Table Editor now and then.

## Swapping in your tool art

See `TOOL_ART` in `studio.html`: replace an image with your pixel art (tool
on the diagonal, working end toward the top-right, transparent background).
The toolbar icon and 3D model are built from it automatically.
