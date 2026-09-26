# Pygmalion's 100% Authentic Sculpting Experience

Carve a block of stone in the browser, publish it, and browse what everyone else made.

```
index.html        Gallery (home page): browse, search, like, view in 3D, remix
studio.html       The sculpting studio, with "Publish to gallery"
js/engine.js      The stone block, tools, meshing, and the .sclp save format
js/stone.js       Stone material (photo texture, paint, bump)
js/viewer.js      3D viewer used by the gallery
js/store.js       Gallery storage: DigitalOcean API, or browser demo mode
server/index.js   Node API for gallery data and Spaces file storage
server/schema.sql PostgreSQL schema
assets/stone.jpg  Stone texture
```

## 1. Run it on your computer

The site uses separate JavaScript files, so it has to be served over http
(double-clicking the HTML files won't work). The VS Code static preview at
`http://localhost:3000/-hacks12/` continues to use browser-only demo data.
To run the API locally, use:

```
npm install
npm start
```

Open `http://localhost:3001/`. Without DigitalOcean settings, it also uses
demo mode. To test the shared gallery, configure the environment variables
described below before starting the server.

## 2. Connect DigitalOcean storage and database

1. Create a **Spaces** bucket for the sculpture files. Keep it private; the
  API streams public gallery files without exposing Spaces credentials.
2. Create a **Managed PostgreSQL** database. Save its connection string and
  download its CA certificate. Allow the App Platform service to connect.
3. Create a **DigitalOcean App Platform** web service from this repository.
  Use the repository root, `npm install` as the build command, and `npm start`
  as the run command. The Node service serves both the pages and `/api`.
4. Add these App Platform environment variables (mark credentials as secret):

  ```
  NODE_ENV=production
  DATABASE_URL=<Managed PostgreSQL connection string>
  DATABASE_CA_CERT=<contents of the database CA certificate>
  SPACES_ENDPOINT=https://<region>.digitaloceanspaces.com
  SPACES_REGION=us-east-1
  SPACES_BUCKET=<private bucket name>
  SPACES_ACCESS_KEY_ID=<Spaces access key>
  SPACES_SECRET_ACCESS_KEY=<Spaces secret key>
  ```

  Create a Spaces access key for this app and keep both key values on the
  server. Never put them in `js/config.js` or frontend code.
5. Run `npm run db:setup` once with `DATABASE_URL` and `DATABASE_CA_CERT` set
  and network access to the managed database. It creates the gallery tables.
6. Deploy the App Platform service. Open its URL; the demo-mode notice should
  disappear once the API can connect to PostgreSQL and Spaces.

The app expects the database CA certificate so PostgreSQL connections are
encrypted and verified. The private Spaces bucket is read and written only by
the API service.

## How the gallery works

- **No accounts.** People publish with a display name. Each browser keeps a
  private random key; only its SHA-256 hash is stored with the sculpture, so
  that browser (and only it) sees a **Delete** button on its own work.
  Clearing browser data loses that key.
- **Likes** are one per sculpture per browser (remembered in the browser).
- **Reports**: one report per browser key; 3 reports hide a sculpture. To
  restore one, update its `hidden` value in PostgreSQL.
- **Remix** opens `studio.html?remix=<id>`; the published result links back to
  the original.
- **Links** like `index.html#sculpture=<id>` open a sculpture directly
  ("Copy link" in the viewer).
- **Files**: each sculpture is a `.sclp` file (typically 5-60 KB) plus a
  512 px WebP picture in private Spaces storage; the API streams them to the
  gallery.

### Known limits (fine for a hackathon, worth revisiting later)

- Basic API rate limiting is enabled, but a determined person could still
  spam uploads; add stronger abuse controls before a large public launch.
- Deleted or hidden sculptures stay in storage (they're just not listed).
- Moderation is only the report threshold; check the Table Editor now and then.

## Swapping in your tool art

See `TOOL_ART` in `studio.html`: replace an image with your pixel art (tool
on the diagonal, working end toward the top-right, transparent background).
The toolbar icon and 3D model are built from it automatically.
