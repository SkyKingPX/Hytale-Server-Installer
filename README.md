# Hytale-Server-Installer
This program downloads the latest hytale server version and can automatically start the server with custom arguments

# Configuration
Default config:
```json
{
  "startServer": true, <- Starts the hytale server with "hytaleArgs"
  "cleanUp": true, <- Deletes downloaded files and remaining folders that are not being used anymore
  "downloaderArgs": "", <- Downloader Arguments, e.g. "--patchline pre-release"
  "javaArgs": "-Xms2G -Xmx4G -XX:AOTCache=HytaleServer.aot", <- Java arguments (Not arguments for the Hytale server!)
  "hytaleArgs": "--assets Assets.zip --bind 5520" <- Arguments for the Hytale server
}
```

# Reporting issues/bugs
If you encounter any issues, please create an Issue in the issues tab.

# Building from source
Run `npx pkg hytale-server-installer.cjs --targets node20-win-x64,node20-linux-x64,node20-macos-x64 --no-bytecode --public`
