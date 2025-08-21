@_default:
    just --list

@fix-openapi inputPath outputPath:
    echo "Fixing OpenAPI spec..."
    bun run fix-elysia-openapi.js {{inputPath}} /tmp/fix-openapi.json
    bun run extract-openapi-schemas.js /tmp/fix-openapi.json {{outputPath}}