# libecity-desktop

Super simple desktop app to load [リベシティチャット](https://libecity.com/).

## Features

- Keep it running in the system tray
- Desktop notification

## To Develop

To clone and run this repository you'll need [Git](https://git-scm.com) and [Node.js](https://nodejs.org/en/download/) (which comes with [npm](http://npmjs.com)) installed on your computer. From your command line:

```bash
# Clone this repository
git clone https://github.com/sugi/libecity-desktop
# Go into the repository
cd libecity-desktop
# Install dependencies
npm install
# Run the app
npm start
```

Note: If you're using Linux Bash for Windows, [see this guide](https://www.howtogeek.com/261575/how-to-run-graphical-linux-desktop-applications-from-windows-10s-bash-shell/) or use `node` from the command prompt.

## Capturing API traffic

libecity's API is undocumented, so the app can capture its own requests to help
diagnose a break (a changed endpoint, a changed auth flow). The capture is
**off by default** in both development and installed builds: it attaches a
Chrome DevTools Protocol debugger, which claims the slot DevTools itself needs,
and it records chat traffic.

```bash
# development
LIBECITY_DUMP=1 npm start
# installed build
libecity-desktop --dump-api
```

Captures land in `<userData>/dump/session-<timestamp>.jsonl`, one per run, and
are never deleted automatically - remove them yourself when you are done.

Credentials (Authorization headers, cookies, JWTs, Firebase refresh tokens,
`gsessionid`) are redacted as they are written. This is best effort and it does
**not** make a capture publishable: bodies still contain chat content and
account data. To keep credentials intact - needed only when the auth flow
itself is what is broken - use `--dump-secrets` / `LIBECITY_DUMP_SECRETS=1`,
which implies `--dump-api`.

`node scripts/analyze-dump.mjs <file>` summarises a capture into a report.

## Resources for Learning Electron

- [electronjs.org/docs](https://electronjs.org/docs) - all of Electron's documentation
- [Electron Fiddle](https://electronjs.org/fiddle) - create, play, and share small Electron experiments
- [electronjs.org/community#boilerplates](https://electronjs.org/community#boilerplates) - sample starter apps created by the community
- [electron/electron-quick-start](https://github.com/electron/electron-quick-start) - a very basic starter Electron app
- [electron/simple-samples](https://github.com/electron/simple-samples) - small applications with ideas for taking them further
- [hokein/electron-sample-apps](https://github.com/hokein/electron-sample-apps) - small demo apps for the various Electron APIs

## License

- libecity-desktop is distributed under [MIT License](LICENSE-MIT.md)
- electron-quick-start-typescript is distributed under [CC0 1.0 (Public Domain)](LICENSE-CC0.md)
