# Dependency and provenance notes

The custom extension and helper sources were extracted into this repository without the original private repository's Git history. Tests use synthetic fixtures. Private configuration, credentials and captured content are not distribution assets.

## Pi

The installed `@earendil-works/pi-coding-agent`, `pi-ai`, `pi-tui` and TypeBox packages are provided by the host. Pi declares the MIT license. Their upstream license notices remain applicable.

Workflows loads the subagent example from the installed Pi distribution. That implementation is not vendored into this repository. Its compatibility and notices belong to the selected host distribution. See [Pi](https://github.com/earendil-works/pi).

## Runtime dependencies

`ws` is an MIT-licensed dependency. Its distribution retains its own LICENSE and copyright notices. It is installed as a dependency, not copied into extension source.

Optional Python features acquire `rmscene`, Pillow or trafilatura through uv. Those distributions and their transitive dependencies retain their upstream licenses. They are not vendored or relicensed by this repository. Review their resolved versions before updating or redistributing an environment.

Brave, Microsoft 365, Notion, Claude, OpenAI, reMarkable and Apple service/application names identify integrations. This repository includes neither their credentials nor a license to access their services.

Preserve these notes when adding or vendoring upstream code.
