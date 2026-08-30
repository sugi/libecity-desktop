// The package ships no type declarations; it exports a single boolean that is
// true only when Electron was launched by a Squirrel setup/update event.
declare module "electron-squirrel-startup" {
  const startedBySquirrel: boolean;
  export default startedBySquirrel;
}
