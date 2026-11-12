const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`tracebac needs Node 22.18 or newer, you have ${process.versions.node}. get a current version at https://nodejs.org`);
  process.exit(1);
}
