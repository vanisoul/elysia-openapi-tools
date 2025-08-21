#!/usr/bin/env bun
/**
 * 將 Elysia 產生 OpenAPI 修復為標準 3.0 規格。
 * 用法：
 *   bun run fix-elysia-openapi.js input.json output.json
 */

import fs from "node:fs/promises";
import path from "node:path";

const rules = [
  // multipart/form-data 如果是 file 就保留, 反之就刪除
  {
    key: "multipart/form-data",
    convert: (data) => {
      const file = data?.schema?.properties?.file;
      if (file) {
        return data;
      }
      return;
    },
  },
  // text/plain 直接刪除
  {
    key: "text/plain",
    convert: (data) => {
      return;
    },
  },
  // application/json 是 file 刪除, 反之保留
  {
    key: "application/json",
    convert: (data) => {
      const file = data?.schema?.properties?.file;
      if (file) {
        return;
      }
      return data;
    },
  },
  // const 轉為 enum
  {
    key: "const",
    convert: (data) => {},
    append: (data) => {
      return {
        enum: [data],
      };
    },
  },
  // 200 OK 要加入 description = "成功回應",
  // 且內容有 items 要刪除
  {
    key: "200",
    convert: (data) => {
      data.description = "成功回應";
      if (data.items) {
        // biome-ignore lint/performance/noDelete: <explanation>
        delete data.items;
      }
      return data;
    },
  },
  // 400 Bad Request 要加入 description = "錯誤的請求",
  {
    key: "400",
    convert: (data) => {
      data.description = "錯誤的請求";
      return data;
    },
  },
  // 401 Unauthorized 要加入 description = "未授權",
  {
    key: "401",
    convert: (data) => {
      data.description = "未授權";
      return data;
    },
  },
  // 201 Created 要加入 description = "已建立",
  {
    key: "201",
    convert: (data) => {
      data.description = "已建立";
      return data;
    },
  },
  // 500 Internal Server Error 要加入 description = "伺服器錯誤
  {
    key: "500",
    convert: (data) => {
      data.description = "伺服器錯誤";
      return data;
    },
  },
  // type 為 "null" 改為 string, 且 append enum 為 ["null"]
  {
    key: "type",
    convert: (data) => {
      if (data === "null") {
        return "string";
      }
      return data;
    },
    append: (data) => {
      if (data === "null") {
        return {
          enum: ["null"],
        };
      }
      return;
    },
  },
  // anyOf 其值 為 Array, 且其中一個物件內容有 "type": "Date", 就刪除此物件, 但是 append  {"format": "date-time","type": "string"}
  /*
  -------
  改為 anyOf 的情況下，會被轉為移除 anyOf, 改為 type: "string", enum: ["null"]
  "anyOf": [
    {
      "type": "string"
    },
    {
      "type": "null"
    }
  ]
  -------
  同樣 type 且不為 null 的情況下，會被轉為移除 anyOf, 改為 enum: [.....]
  "anyOf": [
    {
      "description": "他方",
      "type": "string",
      "const": "Other"
    },
    {
      "description": "我方",
      "type": "string",
      "const": "Ours"
    },
    {
      "description": "雙方",
      "type": "string",
      "const": "Both"
    }
  ]
  -------
  "anyOf": [
    {
      "format": "numeric",
      "default": 0,
      "type": "string"
    },
    {
      "type": "number"
    }
  ]
  */
  {
    key: "anyOf",
    convert: (data) => {
      if (Array.isArray(data)) {
        const hasDate = data.some((item) => item.type === "Date");
        const isNull = data.length === 2 && data.some((item) => item.type === "null");
        const isOne = data.length === 1;
        const isSameType = data.every((item) => item.type === data[0].type && item.type !== "null");
        const isNumeric = data.some((item) => item.format === "numeric" && item.type === "string");

        if (hasDate || isNull || isOne || isSameType || isNumeric) {
          return;
        }
      }
      return data;
    },
    append: (data) => {
      if (Array.isArray(data)) {
        const hasDate = data.some((item) => item.type === "Date");
        if (hasDate) {
          return {
            format: "date-time",
            type: "string",
          };
        }
        const isNull = data.length === 2 && data.some((item) => item.type === "null");
        if (isNull) {
          const typeObj = data.find((item) => item.type !== "null");
          return {
            type: typeObj.type,
            nullable: true,
          };
        }
        const isOne = data.length === 1;
        if (isOne) {
          const typeObj = data[0];
          return typeObj;
        }

        const isSameType = data.every((item) => item.type === data[0].type && item.type !== "null");
        if (isSameType) {
          return {
            type: data[0].type,
            enum: data.map((item) => item.const),
          };
        }

        const isNumeric = data.some((item) => item.format === "numeric" && item.type === "string");
        if (isNumeric) {
          return {
            type: "number",
            default: 0,
          };
        }
      }
      return;
    },
  },
];

const inputPath = process.argv[2];
const outputPath = process.argv[3];

if (!inputPath || !outputPath) {
  console.error("請提供輸入出檔案路徑。例如：bun run extract-openapi-schemas.js openapi.json out.json");
  process.exit(1);
}

const INPUT = path.resolve(process.cwd(), inputPath);
const OUTPUT = path.resolve(process.cwd(), outputPath);
const text = await fs.readFile(INPUT, "utf-8");
const openapiJson = JSON.parse(text);

function removeMultipartAndTextPlainFields(obj) {
  // 如果是陣列就 map 處理每個元素, 並回應新陣列
  if (Array.isArray(obj)) {
    return obj.map(removeMultipartAndTextPlainFields);
  }

  for (const key in obj) {
    // 從 rules 中找出 === key 的規則
    const rule = rules.find((r) => r.key === key);
    if (rule) {
      // 如果符合規則，則呼叫 convert 函數
      const data = rule.convert(obj[key]);
      const appendData = rule.append ? rule.append(obj[key]) : undefined;
      if (appendData) {
        Object.assign(obj, appendData);
      }
      if (data) {
        obj[key] = removeMultipartAndTextPlainFields(data);
      } else {
        delete obj[key];
      }
    } else if (typeof obj[key] === "object" && obj[key] !== null) {
      // Recursively process nested objects
      obj[key] = removeMultipartAndTextPlainFields(obj[key]);
    }
  }

  return obj;
}

const output = removeMultipartAndTextPlainFields(openapiJson);
await fs
  .writeFile(OUTPUT, JSON.stringify(output, null, 2))
  .then(() => {
    console.log("OpenAPI JSON converted and saved successfully.");
  })
  .catch((error) => {
    console.error("Error writing file:", error);
  });
