#!/usr/bin/env node
// @ts-check

import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  outdir: 'dist',
  external: ['electron'],
})

await esbuild.build({
  entryPoints: ['src/renderer.ts', 'src/preload.ts'],
  bundle: true,
  platform: 'browser',
  target: ['chrome120'],
  outdir: 'dist',
  external: ['electron'],
})
