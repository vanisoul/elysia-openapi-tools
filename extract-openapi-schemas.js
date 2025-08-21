#!/usr/bin/env bun
/**
 * 將 OpenAPI 內所有 inline object schema 抽到 components.schemas，並以結構化名稱產生 $ref。
 * 用法：
 *   bun run extract-openapi-schemas.js input.json output.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("請提供輸入出檔案路徑。例如：bun run extract-openapi-schemas.js openapi.json out.json");
  process.exit(1);
}

const INPUT = path.resolve(process.cwd(), inputPath);
const OUTPUT = path.resolve(process.cwd(), outputPath);

const text = await fs.readFile(INPUT, "utf-8");
const doc = JSON.parse(text);
if (!doc.components) doc.components = {};
if (!doc.components.schemas) doc.components.schemas = {};

const schemas = doc.components.schemas;

/** 字串 -> PascalCase */
function toPascal(str) {
  return String(str)
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join("");
}

/** MIME 轉名稱片段 */
function mimeToName(mime) {
  if (!mime) return "";
  return mime.split("/").map(toPascal).join("");
}

/** 避免命名衝突 */
const usedNames = new Set(Object.keys(schemas));
function makeUniqueName(base) {
  let name = base;
  let i = 2;
  while (usedNames.has(name)) {
    name = `${base}${i}`;
    i++;
  }
  usedNames.add(name);
  return name;
}

/** 依結構片段組裝名稱 */
function buildName(parts) {
  const cleaned = parts
    .filter(Boolean)
    .map(String)
    .map((p) => {
      if (p === "schema") return "Schema";
      if (p === "content") return "Content";
      if (p === "responses") return "Responses";
      if (p === "requestBody") return "RequestBody";
      if (p === "parameters") return "Parameters";
      if (p === "items") return "Item";
      if (p === "properties") return "";
      if (p.includes("/")) return mimeToName(p);
      if (["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(p.toLowerCase())) {
        return toPascal(p);
      }
      return toPascal(p);
    })
    .filter(Boolean);

  const base = cleaned.join("");
  return makeUniqueName(base);
}

/** 內容相同的 object schema 共用同一名稱 */
const schemaCache = new Map(); // jsonString -> schemaName

/**
 * 遞迴訪問：會根據 canHoist 決定是否把「本節點」抽離成 components.schemas
 * - canHoist=true：允許把此節點（若為 object-like）抽離
 * - canHoist=false：只處理內部巢狀，不抽離本節點
 */
function visit(node, nameParts, { canHoist = true } = {}) {
  if (!node || typeof node !== "object") return node;

  // 保留既有 $ref
  if (node.$ref) return node;

  // 先處理子節點（不論是否 hoist 本身）
  // 陣列
  if (node.type === "array" && node.items) {
    node.items = visit(node.items, [...nameParts, "items"], { canHoist: true });
  }

  // anyOf/oneOf/allOf
  // biome-ignore lint/complexity/noForEach: <explanation>
  ["anyOf", "oneOf", "allOf"].forEach((key) => {
    if (Array.isArray(node[key])) {
      node[key] = node[key].map((sub, idx) => visit(sub, [...nameParts, key, idx], { canHoist: true }));
    }
  });

  // properties
  if (node.properties && typeof node.properties === "object") {
    for (const [propName, propSchema] of Object.entries(node.properties)) {
      node.properties[propName] = visit(propSchema, [...nameParts, propName], { canHoist: true });
    }
  }

  // additionalProperties
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    node.additionalProperties = visit(node.additionalProperties, [...nameParts, "additionalProperties"], {
      canHoist: true,
    });
  }

  // 是否為 object-like（要被 hoist 的目標）
  const isObjectLike =
    node.type === "object" ||
    (node.properties && typeof node.properties === "object") ||
    (node.additionalProperties && typeof node.additionalProperties === "object" && !node.additionalProperties.$ref);

  // 決定是否 hoist 本節點
  if (canHoist && isObjectLike) {
    const frozenCopy = JSON.stringify(node);

    // 如果之前已抽過相同結構，直接回傳 $ref（避免重複定義）
    if (schemaCache.has(frozenCopy)) {
      const existedName = schemaCache.get(frozenCopy);
      return { $ref: `#/components/schemas/${existedName}` };
    }

    // 產生名稱並存入 components.schemas
    const name = buildName(nameParts);
    const definition = JSON.parse(JSON.stringify(node)); // 深拷貝
    schemas[name] = definition;
    schemaCache.set(frozenCopy, name);

    return { $ref: `#/components/schemas/${name}` };
  }

  return node;
}

/** 走訪 paths */
function processPaths(doc) {
  if (!doc.paths) return;
  for (const [rawPath, pathItem] of Object.entries(doc.paths)) {
    const pathName = toPascal(rawPath.replace(/^\//, "")); // "/about" -> "About"

    for (const [method, op] of Object.entries(pathItem)) {
      const methodLc = method.toLowerCase();
      if (!["get", "post", "put", "patch", "delete", "options", "head", "trace"].includes(methodLc)) continue;

      // parameters
      if (Array.isArray(op.parameters)) {
        op.parameters = op.parameters.map((p, idx) => {
          if (p.schema) {
            p.schema = visit(p.schema, [pathName, methodLc, "parameters", idx, "schema"], { canHoist: true });
          }
          return p;
        });
      }

      // requestBody
      // biome-ignore lint/complexity/useOptionalChain: <explanation>
      if (op.requestBody && op.requestBody.content) {
        for (const [mime, media] of Object.entries(op.requestBody.content)) {
          if (media.schema) {
            media.schema = visit(media.schema, [pathName, methodLc, "requestBody", "content", mime, "schema"], {
              canHoist: true,
            });
          }
        }
      }

      // responses
      if (op.responses && typeof op.responses === "object") {
        for (const [status, resp] of Object.entries(op.responses)) {
          if (resp.content) {
            for (const [mime, media] of Object.entries(resp.content)) {
              if (media.schema) {
                media.schema = visit(
                  media.schema,
                  [pathName, methodLc, "responses", status, "content", mime, "schema"],
                  { canHoist: true },
                );
              }
            }
          }
          // response headers schema
          if (resp.headers && typeof resp.headers === "object") {
            for (const [hName, hObj] of Object.entries(resp.headers)) {
              if (hObj.schema) {
                hObj.schema = visit(
                  hObj.schema,
                  [pathName, methodLc, "responses", status, "headers", hName, "schema"],
                  { canHoist: true },
                );
              }
            }
          }
        }
      }
    }
  }
}

/** 走訪 components（除了 schemas 頂層本體不可 hoist） */
function processComponents(doc) {
  if (!doc.components) return;

  // parameters
  if (doc.components.parameters) {
    for (const [pName, pObj] of Object.entries(doc.components.parameters)) {
      if (pObj.schema) {
        pObj.schema = visit(pObj.schema, ["Components", "Parameters", pName, "Schema"], { canHoist: true });
      }
    }
  }

  // requestBodies
  if (doc.components.requestBodies) {
    for (const [rbName, rb] of Object.entries(doc.components.requestBodies)) {
      if (rb.content) {
        for (const [mime, media] of Object.entries(rb.content)) {
          if (media.schema) {
            media.schema = visit(media.schema, ["Components", "RequestBodies", rbName, "Content", mime, "Schema"], {
              canHoist: true,
            });
          }
        }
      }
    }
  }

  // responses
  if (doc.components.responses) {
    for (const [rName, r] of Object.entries(doc.components.responses)) {
      if (r.content) {
        for (const [mime, media] of Object.entries(r.content)) {
          if (media.schema) {
            media.schema = visit(media.schema, ["Components", "Responses", rName, "Content", mime, "Schema"], {
              canHoist: true,
            });
          }
        }
      }
    }
  }

  // headers
  if (doc.components.headers) {
    for (const [hName, h] of Object.entries(doc.components.headers)) {
      if (h.schema) {
        h.schema = visit(h.schema, ["Components", "Headers", hName, "Schema"], { canHoist: true });
      }
    }
  }

  // 重要：處理既有的 components.schemas
  // 這裡 **不 hoist 頂層**，只走訪其內部以抽離巢狀 inline object
  if (doc.components.schemas) {
    for (const [sName, sObj] of Object.entries(doc.components.schemas)) {
      // 僅遞迴處理內部；canHoist=false 避免自我參考
      doc.components.schemas[sName] = visit(sObj, ["Components", "Schemas", sName], { canHoist: false });
    }
  }
}

/** 執行 */
processPaths(doc);
processComponents(doc);

// 寫回
await fs.writeFile(OUTPUT, JSON.stringify(doc, null, 2), "utf-8");
console.log(`完成：輸出 -> ${OUTPUT}`);
