import { createRequire } from 'module'; const require = createRequire(import.meta.url);
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/security/attachment-path.ts
import * as fs from "fs";
function validateAttachmentPath(filePath) {
  if (filePath.includes("..")) {
    return "Attachment path contains path traversal (..)";
  }
  let resolved;
  try {
    resolved = fs.realpathSync(filePath);
  } catch {
    return `Attachment path does not exist or is not accessible: ${filePath}`;
  }
  if (/\/\./.test(resolved)) {
    return "Attachment path points to a hidden file/directory";
  }
  if (resolved.startsWith("/etc") || resolved.startsWith("/proc") || resolved.startsWith("/sys")) {
    return "Attachment path points to a system directory";
  }
  const inAllowed = ALLOWED_ATTACHMENT_DIRS.some((dir) => resolved.startsWith(dir));
  if (!inAllowed) {
    return `Attachment must be in one of: ${ALLOWED_ATTACHMENT_DIRS.join(", ")}`;
  }
  return null;
}
var ALLOWED_ATTACHMENT_DIRS;
var init_attachment_path = __esm({
  "src/security/attachment-path.ts"() {
    "use strict";
    ALLOWED_ATTACHMENT_DIRS = [
      "/tmp",
      // The project's evidence convention: data/attachments/YYMM/<vendor>/... (CLAUDE.md)
      `${process.env.HOME}/projects/ipk-browser-mcp/data/attachments`,
      `${process.env.HOME}/Downloads`,
      `${process.env.HOME}/Documents`,
      `${process.env.HOME}/Desktop`
    ];
  }
});

// src/internal/primitives/attachment.ts
var attachment_exports = {};
__export(attachment_exports, {
  attachFiles: () => attachFiles,
  attachRevisionFiles: () => attachRevisionFiles,
  clearAllAttachments: () => clearAllAttachments
});
import * as fs6 from "fs";
async function attachFiles(ctx, filePaths) {
  const result = { attached: 0, skipped: [] };
  const valid = [];
  for (const p of filePaths) {
    const pathErr = validateAttachmentPath(p);
    if (pathErr) {
      result.skipped.push({ path: p, reason: pathErr });
      continue;
    }
    if (!fs6.existsSync(p)) {
      result.skipped.push({ path: p, reason: "file not found on local fs" });
    } else {
      valid.push(p);
    }
  }
  if (valid.length === 0) return result;
  await ctx.evaluate((n) => {
    const sel = document.querySelector(
      'select[name="file_attach_cnt"]'
    );
    if (sel) {
      sel.value = String(n);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, valid.length);
  await ctx.waitForTimeout(300);
  const fileLocators = ctx.locator('input[name="doc_attach_file[]"]');
  for (let i = 0; i < valid.length; i++) {
    try {
      await fileLocators.nth(i).setInputFiles(valid[i]);
      result.attached += 1;
    } catch (err) {
      result.skipped.push({
        path: valid[i],
        reason: `setInputFiles failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  return result;
}
async function attachRevisionFiles(ctx, filePaths) {
  const result = { attached: 0, skipped: [] };
  const valid = [];
  for (const p of filePaths.slice(0, 3)) {
    const pathErr = validateAttachmentPath(p);
    if (pathErr) {
      result.skipped.push({ path: p, reason: pathErr });
      continue;
    }
    if (!fs6.existsSync(p)) {
      result.skipped.push({ path: p, reason: "file not found on local fs" });
    } else {
      valid.push(p);
    }
  }
  const fileLocators = ctx.locator('input[name="trans_attach_file[]"]');
  for (let i = 0; i < valid.length; i++) {
    try {
      await fileLocators.nth(i).setInputFiles(valid[i]);
      result.attached += 1;
    } catch (err) {
      result.skipped.push({
        path: valid[i],
        reason: `setInputFiles failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
  }
  return result;
}
async function clearAllAttachments(ctx, opts = {}) {
  const maxIter = opts.maxIter ?? 25;
  const waitMs = opts.waitMs ?? 1500;
  let deleted = 0;
  const readExisting = async () => {
    return await ctx.evaluate(() => {
      const out = [];
      for (const a of Array.from(document.querySelectorAll("a"))) {
        const href = a.getAttribute("href") || "";
        const m = href.match(/del_file\('(\d+)'\)/);
        if (m) out.push(m[1]);
      }
      return [...new Set(out)];
    });
  };
  let existing = await readExisting();
  let iter = 0;
  while (existing.length > 0 && iter < maxIter) {
    iter += 1;
    const order = existing[0];
    try {
      await ctx.evaluate((flag) => {
        const delNo = document.getElementById("del_no");
        const modeEl = document.all?.("mode");
        if (delNo) delNo.value = flag;
        if (modeEl) modeEl.value = "file";
        const form = document.form1;
        if (form) form.submit();
      }, order);
    } catch {
      break;
    }
    try {
      await ctx.waitForLoadState("networkidle", { timeout: 15e3 });
    } catch {
    }
    await ctx.waitForTimeout(waitMs);
    deleted += 1;
    existing = await readExisting();
  }
  return { deleted, remaining: existing };
}
var init_attachment = __esm({
  "src/internal/primitives/attachment.ts"() {
    "use strict";
    init_attachment_path();
  }
});

// src/internal/primitives/account.ts
var account_exports = {};
__export(account_exports, {
  fetchAccountCodes: () => fetchAccountCodes,
  pickAccountCode: () => pickAccountCode,
  setAccountCodeOnRow: () => setAccountCodeOnRow
});
async function fetchAccountCodes(page, opts) {
  const flag = opts.rowFlag ?? "1";
  const url = `${opts.baseUrl}/Document/pr_account_sel.php?budget_type=${encodeURIComponent(opts.budgetType)}&budget_code=${encodeURIComponent(opts.budgetCode)}&sel_item=${encodeURIComponent(flag)}&approve_type=${encodeURIComponent(opts.approveType)}`;
  const ctx = page.context();
  const probe = await ctx.newPage();
  try {
    await probe.goto(url, { waitUntil: "networkidle", timeout: 3e4 });
    return await probe.evaluate(() => {
      const result = [];
      const links = Array.from(document.querySelectorAll("a"));
      for (const a of links) {
        const oc = a.getAttribute("onclick") || "";
        const m = oc.match(
          /Check_Item\(\s*'([^']*)'\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/
        );
        if (m) {
          result.push({ seq: m[1], code: m[2], label: m[3] });
        }
      }
      return result;
    });
  } finally {
    await probe.close();
  }
}
async function setAccountCodeOnRow(ctx, rowIdx, account) {
  await ctx.evaluate(
    ({ rowIdx: rowIdx2, account: account2 }) => {
      const acStr = document.getElementsByName(
        "account_str[]"
      );
      const acCode = document.getElementsByName(
        "account_code[]"
      );
      const acSeq = document.getElementsByName(
        "account_seq[]"
      );
      const msSeq = document.getElementsByName(
        "milestone_seq[]"
      );
      const msChk = document.getElementsByName(
        "milestone_check"
      );
      if (acStr[rowIdx2]) acStr[rowIdx2].value = `[${account2.code}] ${account2.label}`;
      if (acCode[rowIdx2]) acCode[rowIdx2].value = account2.code;
      if (acSeq[rowIdx2]) acSeq[rowIdx2].value = account2.seq;
      if (msSeq[rowIdx2]) msSeq[rowIdx2].value = "";
      if (msChk[rowIdx2]) msChk[rowIdx2].value = "-";
    },
    { rowIdx, account }
  );
}
async function pickAccountCode(page, opts, labelMatch) {
  const codes = await fetchAccountCodes(page, opts);
  const matcher = typeof labelMatch === "string" ? (s) => s.toLowerCase().includes(labelMatch.toLowerCase()) : (s) => labelMatch.test(s);
  return codes.find((c) => matcher(c.label)) ?? null;
}
var init_account = __esm({
  "src/internal/primitives/account.ts"() {
    "use strict";
  }
});

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path: path9, errorMaps, issueData } = params;
  const fullPath = [...path9, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path9, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path9;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// src/hot-reload.ts
var SHIM_API_VERSION = 1;

// src/util.ts
function textResult(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }]
  };
}

// src/tools/ipk-login.ts
var ipkLoginSchema = {
  username: external_exports.string().optional().describe("IPK groupware username. Falls back to IPK_USERNAME env var."),
  password: external_exports.string().optional().describe("IPK groupware password. Falls back to IPK_PASSWORD env var.")
};
var ipkLoginDescription = "Log in to IPK groupware (gw.ip-korea.org). Returns a session for subsequent tool calls. Credentials can be provided as parameters or via IPK_USERNAME/IPK_PASSWORD environment variables. Env config path: ~/.config/ipk-browser-mcp/.env (IPK_USERNAME, IPK_PASSWORD, IPK_BASE_URL, SCREENSHOT_DIR).";
async function handleIpkLogin(sessionManager, params) {
  const username = params.username || process.env.IPK_USERNAME || "";
  const password = params.password || process.env.IPK_PASSWORD || "";
  const result = await sessionManager.login(username, password);
  if (result.error) {
    return textResult({ error: true, code: result.code, message: result.message });
  }
  return textResult({
    error: false,
    data: {
      sessionId: result.data.sessionId,
      loggedIn: result.data.loggedIn,
      userInfo: {
        username: result.data.userInfo.username,
        name: result.data.userInfo.name
      }
    }
  });
}

// src/tools/ipk-submit.ts
import * as fs7 from "fs";
init_attachment_path();

// src/internal/audit.ts
import * as fs2 from "fs";
import * as path from "path";
var LOG_PATH = path.resolve(
  process.env.IPK_AUDIT_DIR || path.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp"),
  "audit.jsonl"
);
var runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
var enabled = process.env.IPK_AUDIT !== "0";
function beginRun(id) {
  runId = id || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return runId;
}
function audit(event) {
  if (!enabled) return;
  try {
    fs2.mkdirSync(path.dirname(LOG_PATH), { recursive: true, mode: 448 });
    fs2.appendFileSync(LOG_PATH, JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), runId, ...event }) + "\n", "utf8");
  } catch {
  }
}
function toolDraftedDocIds() {
  const out = /* @__PURE__ */ new Set();
  try {
    for (const l of fs2.readFileSync(LOG_PATH, "utf8").split("\n")) {
      if (!l) continue;
      try {
        const e = JSON.parse(l);
        if ((e.action === "submit" || e.action === "draft_save") && e.docId) out.add(String(e.docId));
      } catch {
      }
    }
  } catch {
  }
  return out;
}

// src/forms/card-er.ts
var CARD_PREFIX = /^\s*\[\s*card\s*\]\s*/i;
function normalizeCardSubject(subject) {
  let rest = String(subject ?? "");
  while (CARD_PREFIX.test(rest)) rest = rest.replace(CARD_PREFIX, "");
  rest = rest.trim();
  return rest ? `[Card] ${rest}` : "[Card]";
}
function isPreviewBlockedRequest(method, url) {
  const m = String(method || "").toUpperCase();
  if (m !== "GET" && m !== "HEAD") return true;
  return /budget_check_er\.php|document_write\.php|doc_approve/i.test(url);
}
var SCALAR_FIELDS = ["subject", "budget_type", "budget_code", "pay_kind", "mode", "mode1", "p_reason"];
var ROW_FIELD = /^(item_[a-z_]+|account_code|account_str|venue|meeting_begin_date|meeting_end_date|participants|purpose|vender|seller|doc_attach_file)\[\]$/;
function summarizeCapturedForm(entries) {
  const out = {};
  for (const f of SCALAR_FIELDS) {
    const hit = entries.find(([k]) => k === f);
    out[f] = hit ? hit[1] : null;
  }
  for (const [k, v] of entries) {
    if (!ROW_FIELD.test(k)) continue;
    const arr = out[k] ?? [];
    arr.push(v);
    out[k] = arr;
  }
  return out;
}
var MEETING_ACCOUNT_CODES = /* @__PURE__ */ new Set([
  "420420",
  "410307",
  "410310",
  "420450",
  "420451",
  "412104",
  "420421",
  "412106",
  "420422",
  "412107"
]);
function isMeetingAccount(code) {
  return MEETING_ACCOUNT_CODES.has(String(code ?? ""));
}
var OVERTIME_ACCOUNT_CODES = /* @__PURE__ */ new Set(["412103"]);
function isOvertimeAccount(code) {
  return OVERTIME_ACCOUNT_CODES.has(String(code ?? ""));
}
var OVERSEAS_IT_SUBSCRIPTION = /runpod|google cloud|gemini|chatgpt|openai|claude|anthropic|foxit/i;
function isOverseasItSubscription(itemName) {
  return OVERSEAS_IT_SUBSCRIPTION.test(String(itemName ?? ""));
}
var BUDGET_REFUSAL = /not enough budget|insufficient budget|budget (?:is )?exceeded|exceeds? (?:the )?budget/i;
function budgetPopupRefusals(bodyText) {
  return String(bodyText ?? "").split(/\r?\n/).map((l) => l.trim()).filter((l) => BUDGET_REFUSAL.test(l));
}

// src/policy/attachment-review.ts
import * as fs3 from "fs";
import * as crypto from "crypto";
var ATTACHMENT_KINDS = [
  "card_slip",
  "society_receipt",
  "invoice",
  "permission",
  "fee_table",
  "program",
  "usage",
  "receipt",
  "other"
];
var ACCOUNT_ATTACHMENTS_REQUIRED = {
  "410306": {
    kinds: ["card_slip", "society_receipt", "permission", "fee_table", "program"],
    evidenceDocs: ["293384", "296590", "301306"]
  }
};
var VENDOR_ATTACHMENTS_REQUIRED = {
  runpod: {
    kinds: ["invoice", "card_slip", "usage", "receipt"],
    evidenceDocs: ["RunPod ER precedent"]
  }
};
var FILENAME_HINTS = {
  card_slip: /(cc[_-]?sales[_-]?slip|sales[_-]?slip|매출전표)/i,
  invoice: /invoice/i,
  usage: /daily[_-]?usage|usage/i,
  receipt: /receipt/i,
  society_receipt: /receipt/i,
  program: /program/i,
  permission: /permission|invitation/i,
  fee_table: /fee|table|registration/i
};
var ISSUER_STOPWORDS = /\b(korea|society|association|conference|학회|협회)\b/gi;
function requirementFor(params) {
  if (params.accountCode && ACCOUNT_ATTACHMENTS_REQUIRED[params.accountCode]) {
    return ACCOUNT_ATTACHMENTS_REQUIRED[params.accountCode];
  }
  if (params.vendorKey && VENDOR_ATTACHMENTS_REQUIRED[params.vendorKey]) {
    return VENDOR_ATTACHMENTS_REQUIRED[params.vendorKey];
  }
  return null;
}
var MONTHS = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12
};
var MONTH_ALT = "jan|feb|mar|apr|may|jun|jul|aug|sept|sep|oct|nov|dec";
function extractDateCandidates(text) {
  const out = [];
  const push = (month, day, year) => {
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) out.push({ month, day, year });
  };
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\/(${MONTH_ALT})\\.?\\/(\\d{4})`, "gi"))) {
    push(MONTHS[m[2].toLowerCase()], Number(m[1]), Number(m[3]));
  }
  for (const m of text.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) {
    push(Number(m[2]), Number(m[3]), Number(m[1]));
  }
  for (const m of text.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTH_ALT})[a-z]*\\.?\\s+(\\d{1,2})(?:\\s*,?\\s*(\\d{4}))?`, "gi"))) {
    push(MONTHS[m[1].toLowerCase()], Number(m[2]), m[3] ? Number(m[3]) : void 0);
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_ALT})[a-z]*\\.?(?:\\s*,?\\s*(\\d{4}))?`, "gi"))) {
    push(MONTHS[m[2].toLowerCase()], Number(m[1]), m[3] ? Number(m[3]) : void 0);
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\.(?!\d)/g)) {
    push(Number(m[2]), Number(m[1]));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\b(?!\/)/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  for (const m of text.matchAll(/\b(\d{1,2})\.(\d{1,2})\b(?!\.)/g)) {
    push(Number(m[1]), Number(m[2]));
  }
  return out;
}
function quoteMatchesDate(quote, month, day, targetYear) {
  const candidates = extractDateCandidates(quote);
  return candidates.some((c) => {
    if (c.month !== month || c.day !== day) return false;
    if (c.year !== void 0 && targetYear !== void 0 && c.year !== targetYear) return false;
    return true;
  });
}
function quoteMatchesAmount(quote, amount) {
  const normalized = quote.replace(/[,\s]/g, "");
  const nums = normalized.match(/\d+/g) || [];
  return nums.some((n) => Number(n) === amount);
}
function issuerCoreTokens(name) {
  const stripped = name.replace(ISSUER_STOPWORDS, " ").replace(/\b(19|20)\d{2}\b/g, " ");
  return stripped.split(/[\s()\-,./]+/).map((t) => t.trim()).filter((t) => t.length >= 2);
}
function quoteMatchesIssuer(quote, issuerName) {
  const tokens = issuerCoreTokens(issuerName);
  if (tokens.length === 0) return true;
  const lowerQuote = quote.toLowerCase();
  return tokens.some((t) => lowerQuote.includes(t.toLowerCase()));
}
function datesBetween(start, end) {
  if (!start || !end) return [];
  const a = /* @__PURE__ */ new Date(`${start}T00:00:00Z`);
  const b = /* @__PURE__ */ new Date(`${end}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || b < a) return [];
  const out = [];
  for (let t = a.getTime(); t <= b.getTime(); t += 864e5) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
function sha256OfFile(filePath) {
  try {
    const buf = fs3.readFileSync(filePath);
    return crypto.createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}
function exceptionFor(exceptions, kind, date) {
  return (exceptions || []).find((e) => e.kind === kind && e.person_confirmed === true && (date === void 0 || e.date === date));
}
function reviewAttachments(params) {
  const blocks = [];
  const warnings = [];
  const flagged = [];
  const auditRecords = [];
  const req = requirementFor(params);
  const attachments = params.attachments || [];
  if (req) {
    if (attachments.length === 0 && (params.legacyPaths || []).length > 0) {
      blocks.push(
        `This account requires labeled attachments (${req.kinds.join(", ")}) - attachment_path(s) without a kind are refused. Use attachments: [{path, kind}].`
      );
    } else if (attachments.length === 0) {
      blocks.push(`This account requires attachments (${req.kinds.join(", ")}) but none were given.`);
    } else {
      const seen = /* @__PURE__ */ new Map();
      for (const a of attachments) seen.set(a.kind, (seen.get(a.kind) || 0) + 1);
      for (const [kind, count2] of seen) {
        if (count2 > 1) blocks.push(`kind '${kind}' is claimed by ${count2} attachments - one file = one kind.`);
      }
      const present = new Set(attachments.map((a) => a.kind));
      const missing = req.kinds.filter((k) => !present.has(k));
      if (missing.length > 0) {
        blocks.push(`Missing required attachment kind(s): ${missing.join(", ")}.`);
      }
    }
  }
  for (const a of attachments) {
    const hint = FILENAME_HINTS[a.kind];
    if (hint && !hint.test(a.path)) {
      warnings.push(`${a.path}: filename doesn't look like '${a.kind}' - check the label.`);
    }
    const quotes = a.quotes || [];
    if (a.kind === "program" && params.eventStart && params.eventEnd) {
      const targetYear = Number(params.eventStart.slice(0, 4));
      for (const dateStr of datesBetween(params.eventStart, params.eventEnd)) {
        const [, mo, da] = dateStr.split("-").map(Number);
        const matched = quotes.some((q) => quoteMatchesDate(q, mo, da, targetYear));
        if (!matched) {
          const exc = exceptionFor(params.exceptions, "program", dateStr);
          if (exc) {
            flagged.push({ kind: "program", reason: `${dateStr}: attestation_exception (${exc.reason})` });
          } else {
            blocks.push(`program: no quote covers ${dateStr}. Quote the program's own text for this date, or provide attestation_exception.`);
          }
        }
      }
    }
    if (a.kind === "fee_table" && params.totalAmount !== void 0) {
      const matched = quotes.some((q) => quoteMatchesAmount(q, params.totalAmount));
      if (!matched) {
        const exc = exceptionFor(params.exceptions, "fee_table");
        if (exc) {
          flagged.push({ kind: "fee_table", reason: `attestation_exception (${exc.reason})` });
        } else {
          blocks.push(`fee_table: no quote contains the total amount (${params.totalAmount}). Quote the fee table's total, or provide attestation_exception.`);
        }
      }
    }
    if (a.kind === "society_receipt" && params.issuerName) {
      const matched = quotes.some((q) => quoteMatchesIssuer(q, params.issuerName));
      if (!matched) {
        const exc = exceptionFor(params.exceptions, "society_receipt");
        if (exc) {
          flagged.push({ kind: "society_receipt", reason: `attestation_exception (${exc.reason})` });
        } else {
          blocks.push(`society_receipt: no quote names the issuer ('${params.issuerName}'). Quote the receipt's issuer line, or provide attestation_exception.`);
        }
      }
    }
    auditRecords.push({ path: a.path, sha256: sha256OfFile(a.path), kind: a.kind, quote: quotes[0] ?? null });
  }
  return { blocks, warnings, flagged, auditRecords };
}

// src/policy/org-policy.ts
var HANGUL = /[\u1100-\u11FF\u3130-\u318F\uA960-\uA97F\uAC00-\uD7AF\uD7B0-\uD7FF]/;
function containsHangul(s) {
  return typeof s === "string" && HANGUL.test(s);
}
var FREE_TEXT_PARAMS = [
  "subject",
  "title",
  "purpose",
  "destination",
  "reason",
  "details",
  "description",
  "participants",
  "venue",
  "work_place",
  "organization",
  "attendees",
  "schedule",
  "item_name",
  "seller_en",
  "item_description",
  "item_vendor",
  "purpose_minutes",
  "purpose_category",
  "disclosure_purpose",
  "material_description",
  "conference_or_journal",
  "country",
  "conference_name",
  "overtime_purpose"
];
var OVERSEAS_IT_VENDORS = /runpod|openai|chatgpt|anthropic|claude|google cloud|gcp|aws|amazon web|azure|github|vercel|huggingface|hugging face|lambda labs|vast\.ai|modal/i;
var VAT_SPLITTING_FORMS = /* @__PURE__ */ new Set(["expense", "card_expense"]);
var MEETING_ACCOUNT_LABEL = /team activit|meeting/i;
var OVERTIME_ACCOUNT_LABEL = /overtime meal/i;
var OVERTIME_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
var SEOUL_RE = /seoul|서울/i;
var VENDOR_ATTACHMENT_REQUIREMENTS = {
  runpod: [
    { label: "signed invoice", match: /invoice/i },
    { label: "card sales slip", match: /(cc[_-]?sales[_-]?slip|sales[_-]?slip|매출전표)/i },
    { label: "daily usage screenshot", match: /daily[_-]?usage/i },
    { label: "receipt", match: /receipt/i }
  ]
};
function vendorAttachmentKey(params) {
  const text = ["item_name", "seller_en", "item_vendor"].map((k) => typeof params[k] === "string" ? params[k] : "").join(" ").toLowerCase();
  return Object.keys(VENDOR_ATTACHMENT_REQUIREMENTS).find((k) => text.includes(k)) ?? null;
}
function nightsBetween(start, end) {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Math.round((b - a) / 864e5);
}
var ORG_POLICY = [
  {
    id: "ENGLISH_ONLY",
    standard: "Approval documents are written in English. Korean input from the requester is translated before it reaches the form.",
    passes: "No free-text parameter (subject, purpose, destination, reason, ...) contains Hangul.",
    check(params) {
      const fields = FREE_TEXT_PARAMS.filter((k) => containsHangul(params[k]));
      if (fields.length === 0) return null;
      return {
        rule: "ENGLISH_ONLY",
        fields: [...fields],
        message: `Korean text in ${fields.join(", ")}. Approval documents must be in English - translate these values and resubmit. Nothing was written to the form.`
      };
    }
  },
  {
    id: "NO_FINAL_SUBMIT",
    standard: "A document is saved as a draft and reviewed by a person before it is submitted for approval. Submission itself (draft_only=false) is refused by default. A person who wants submission unlocked for this process must set env IPK_ALLOW_SUBMIT=1 - and even then the MCP does not perform the final approval-request click itself (see src/tools/ipk-submit.ts noFinalSubmitNote); it saves a draft and reports the click path for a person to press the button. (Future option, out of scope here: per-call MCP elicitation instead of the env switch.)",
    passes: "draft_only is not false, or (confirm_submit is true AND env IPK_ALLOW_SUBMIT=1).",
    check(params) {
      if (params.draft_only !== false) return null;
      if (params.confirm_submit === true && process.env.IPK_ALLOW_SUBMIT === "1") return null;
      return {
        rule: "NO_FINAL_SUBMIT",
        fields: ["draft_only", "confirm_submit"],
        message: "Submission is refused: set draft_only=true for a draft, or to unlock submission set confirm_submit=true AND the environment variable IPK_ALLOW_SUBMIT=1. Even then, this tool will not click the final approval-request button itself - it saves a draft and tells you where to click."
      };
    }
  },
  {
    id: "CARD_ER_NO_SUBMIT",
    standard: "card_expense_rd (AppFrm-021) is never submitted for approval by this tool, no matter what confirm_submit or IPK_ALLOW_SUBMIT are set to: the real-save path submitted doc 302098 for approval on 2026-10-23 instead of behaving as a draft. The person reviews the preview/screenshot and presses the groupware's own [Request] button themselves.",
    passes: "form_type is not card_expense_rd, or draft_only is not false.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      if (params.draft_only !== false) return null;
      return {
        rule: "CARD_ER_NO_SUBMIT",
        fields: ["form_type", "draft_only"],
        message: "card_expense_rd submission is refused outright - regardless of confirm_submit or env IPK_ALLOW_SUBMIT: this path submitted doc 302098 for approval on 2026-10-23. Run dry_run=true (or draft_only=true) to get the filled-form preview/screenshot, review it, then press [Request] in the browser yourself. Nothing was saved."
      };
    }
  },
  {
    id: "TEAM_ACTIVITY_FIELDS_REQUIRED",
    standard: "A card ER on a meeting account (Team Activities 412107 and the other accounts the account picker treats as meetings) records venue, meeting time, participants and purpose - the page requires venue and meeting time for every meeting account, and precedent documents always carry participants and purpose.",
    passes: "When card_expense_rd is filed with a meeting item_account_code (isMeetingAccount), or with no code and a Team Activities / meeting account_code_label, venue, meeting_begin, meeting_end, participants and purpose_minutes (or purpose) are all non-empty.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const byCode = isMeetingAccount(params.item_account_code);
      const byLabel = !params.item_account_code && MEETING_ACCOUNT_LABEL.test(String(params.account_code_label ?? ""));
      if (!byCode && !byLabel) return null;
      const required = {
        venue: params.venue,
        meeting_begin: params.meeting_begin,
        meeting_end: params.meeting_end,
        participants: params.participants,
        purpose_minutes: params.purpose_minutes || params.purpose
      };
      const fields = Object.entries(required).filter(([, v]) => typeof v !== "string" || v.trim() === "").map(([k]) => k);
      if (fields.length === 0) return null;
      return {
        rule: "TEAM_ACTIVITY_FIELDS_REQUIRED",
        fields,
        message: `Meeting account ${params.item_account_code || params.account_code_label} requires ${fields.join(", ")}. Provide venue, meeting_begin, meeting_end, participants and purpose_minutes (or purpose). Nothing was written to the form.`
      };
    }
  },
  {
    id: "OVERTIME_MEAL_FIELDS_REQUIRED",
    standard: "A card ER on the Overtime Meals account (412103) records the overtime time range and purpose - the page's own Check_Form validation refuses a 412103 row without them ('Please insert Overtime info'), and precedent doc 297084 carries Date/Time and Purpose from the overtime application.",
    passes: "When card_expense_rd is filed with item_account_code 412103 (isOvertimeAccount), or with no code and an Overtime Meals account_code_label, overtime_begin and overtime_end are both non-empty and match 'YYYY-MM-DD HH:MM', overtime_begin is before overtime_end, and overtime_purpose is non-empty.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const byCode = isOvertimeAccount(params.item_account_code);
      const byLabel = !params.item_account_code && OVERTIME_ACCOUNT_LABEL.test(String(params.account_code_label ?? ""));
      if (!byCode && !byLabel) return null;
      const fields = [];
      if (typeof params.overtime_begin !== "string" || !OVERTIME_TIME_RE.test(params.overtime_begin)) fields.push("overtime_begin");
      if (typeof params.overtime_end !== "string" || !OVERTIME_TIME_RE.test(params.overtime_end)) fields.push("overtime_end");
      if (typeof params.overtime_purpose !== "string" || params.overtime_purpose.trim() === "") fields.push("overtime_purpose");
      if (fields.length === 0 && params.overtime_begin >= params.overtime_end) fields.push("overtime_begin/overtime_end order");
      if (fields.length === 0) return null;
      return {
        rule: "OVERTIME_MEAL_FIELDS_REQUIRED",
        fields,
        message: `Overtime Meals account ${params.item_account_code || params.account_code_label} requires ${fields.join(", ")}. Provide overtime_begin and overtime_end as 'YYYY-MM-DD HH:MM' (begin before end) and overtime_purpose. Nothing was written to the form.`
      };
    }
  },
  {
    id: "OVERSEAS_IT_VAT_ZERO",
    standard: "Overseas IT subscriptions (RunPod, OpenAI, Google Cloud, ...) carry no Korean VAT: VAT=0 and the ex-VAT amount equals the total. Splitting VAT out double-taxes the item and the document is sent back.",
    passes: "An expense whose vendor or description names an overseas IT vendor is not filed through a form that derives VAT as amount/1.1.",
    check(params) {
      if (!VAT_SPLITTING_FORMS.has(String(params.form_type))) return null;
      const fields = ["item_vendor", "item_description", "purpose", "details"].filter(
        (k) => typeof params[k] === "string" && OVERSEAS_IT_VENDORS.test(params[k])
      );
      if (fields.length === 0) return null;
      return {
        rule: "OVERSEAS_IT_VAT_ZERO",
        fields,
        message: `${params.form_type} splits VAT as amount/1.1, but ${fields.join(", ")} names an overseas IT vendor that charges no Korean VAT. File it as card_expense_rd (amounts come from the card receipt) so VAT stays 0. Nothing was written to the form.`
      };
    }
  },
  {
    id: "SEOUL_IS_OUTSIDE_METRO",
    standard: "A travel_request to Seoul is filed bound_code '20' (Outside Metropolitan): IPK's Pangyo (Seongnam) HQ puts Seoul outside the metro boundary, not within it, however intuitive '\uC218\uB3C4\uAD8C=\uAD00\uB0B4' sounds. An AI4Sci Korea (Seoul Dragon City) request was drafted '19' and the person corrected it.",
    passes: "When destination names Seoul (English or Hangul), bound_code is '20'.",
    check(params) {
      if (String(params.form_type) !== "travel_request") return null;
      if (!SEOUL_RE.test(String(params.destination ?? ""))) return null;
      if (String(params.bound_code ?? "") === "20") return null;
      return {
        rule: "SEOUL_IS_OUTSIDE_METRO",
        fields: ["bound_code", "destination"],
        message: `destination '${params.destination}' names Seoul; bound_code must be '20' (Outside Metropolitan), not '19' - IPK's Pangyo HQ classifies Seoul as outside the metro boundary. Nothing was written to the form.`
      };
    }
  },
  {
    id: "VENDOR_ATTACHMENTS_REQUIRED",
    standard: "A card ER for a vendor with known attachment requirements (RunPod: signed invoice, card sales slip, daily usage screenshot, receipt) carries all of them - an incomplete set has needed re-attaching before.",
    passes: "When item_name/seller_en/item_vendor names a vendor in the requirements table, attachment_path(s) include a file matching every required kind.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const vendor = vendorAttachmentKey(params);
      if (!vendor) return null;
      const kinds = VENDOR_ATTACHMENT_REQUIREMENTS[vendor];
      const paths = [
        params.attachment_path,
        ...Array.isArray(params.attachment_paths) ? params.attachment_paths : [],
        ...Array.isArray(params.attachments) ? params.attachments.map((a) => a?.path) : []
      ].filter(Boolean);
      const missing = kinds.filter((k) => !paths.some((p) => k.match.test(String(p))));
      if (missing.length === 0) return null;
      return {
        rule: "VENDOR_ATTACHMENTS_REQUIRED",
        fields: ["attachment_paths"],
        message: `${vendor} card ER needs ${kinds.length} attachments (${kinds.map((k) => k.label).join(", ")}); missing: ${missing.map((k) => k.label).join(", ")}. Nothing was written to the form.`
      };
    }
  },
  {
    id: "ACCOUNT_ATTACHMENTS_REQUIRED",
    standard: "A card ER on an account with a known attachment-kind requirement (410306 Participating in Conferences: card sales slip, society/organizer receipt, invitation/permission, fee table, program) carries every required kind, and the attestation quotes required for program/fee_table/ society_receipt attachments actually say what the document claims (event dates, total amount, issuer) - see src/policy/attachment-review.ts for the table and the quote checks.",
    passes: "When item_account_code names an account in ACCOUNT_ATTACHMENTS_REQUIRED (attachment-review.ts), attachments[] (not legacy attachment_path(s)) supplies one labeled file per required kind, no kind duplicated, and every attestation quote reviewAttachments requires is present (or excused via a confirmed attestation_exception). This check is pre-navigation and best-effort on item_account_code alone - the resolved-account check inside submitCardExpenseRD (after Sel_account/Check_Item, before upload) is the actual enforcement point, since account_code_label and the account picker's own defaults are only known once the form is loaded.",
    check(params) {
      if (String(params.form_type) !== "card_expense_rd") return null;
      const accountCode = typeof params.item_account_code === "string" ? params.item_account_code : null;
      if (!accountCode) return null;
      const result = reviewAttachments({
        accountCode,
        attachments: Array.isArray(params.attachments) ? params.attachments : [],
        legacyPaths: Array.isArray(params.attachments) && params.attachments.length > 0 ? [] : [params.attachment_path, ...Array.isArray(params.attachment_paths) ? params.attachment_paths : []].filter(Boolean),
        eventStart: params.event_start,
        eventEnd: params.event_end,
        totalAmount: typeof params.amount === "number" ? params.amount : void 0,
        issuerName: params.organizer || params.seller_en || void 0,
        exceptions: params.attestation_exception
      });
      if (result.blocks.length === 0) return null;
      return {
        rule: "ACCOUNT_ATTACHMENTS_REQUIRED",
        fields: ["attachments"],
        message: result.blocks.join("\n")
      };
    }
  },
  {
    id: "NO_REPORT_FOR_DAY_TRIP",
    standard: "A domestic travel report (form_type 'travel', written onto the approved AppFrm-023 request at travel_report_write.php) is only filed for trips of 2 nights (2\uBC153\uC77C) or more - across the person's 15 domestic trips, all 5 of >=2 nights have a report and all 9 same-day trips do not, no exceptions.",
    passes: "start_date/end_date are absent (nothing to compute yet), or span 2 nights or more.",
    check(params) {
      if (String(params.form_type) !== "travel") return null;
      if (!params.start_date || !params.end_date) return null;
      const nights = nightsBetween(String(params.start_date), String(params.end_date));
      if (Number.isNaN(nights) || nights >= 2) return null;
      return {
        rule: "NO_REPORT_FOR_DAY_TRIP",
        fields: ["start_date", "end_date"],
        message: `start_date/end_date span ${nights} night(s); a domestic travel report is only filed for 2 nights (2\uBC153\uC77C) or more - a same-day or 1-night trip does not get one. Nothing was written to the form.`
      };
    }
  },
  {
    id: "TRAVEL_REPORT_FIELDS_MIN_LENGTH",
    standard: "travel_report_write.php's own Check_Form() rejects purpose_field, agenda_field and result_field under 100 characters - caught here, before the form is touched, using the same fallbacks submitTravel applies (agenda_field falls back to purpose, result_field to 'Expected outcomes: <purpose>').",
    passes: "purpose_field, agenda_field and result_field (after submitTravel's own fallbacks) are each >=100 characters.",
    check(params) {
      if (String(params.form_type) !== "travel") return null;
      const purpose = params.purpose || "Business travel";
      const computed = {
        purpose_field: String(purpose),
        agenda_field: String(params.schedule || purpose),
        result_field: String(params.reason || `Expected outcomes: ${purpose}`)
      };
      const short = Object.keys(computed).filter((k) => computed[k].length < 100);
      if (short.length === 0) return null;
      return {
        rule: "TRAVEL_REPORT_FIELDS_MIN_LENGTH",
        fields: short,
        message: `${short.join(", ")} must each be >=100 characters (travel_report_write.php's own Check_Form() rejects shorter values); lengths: ${short.map((k) => `${k}=${computed[k].length}`).join(", ")}. Nothing was written to the form.`
      };
    }
  }
];
var GENERATED_FILE_DIRS = /^\/tmp\/|\/scratchpad\//;
ORG_POLICY.push({
  id: "NO_GENERATED_EVIDENCE",
  standard: "Attachments are real documents the person supplied (an approval email printed from Gmail, a receipt, an invoice). The tool never fabricates or re-lays-out evidence. doc 299953 went out with a script-rendered PDF that the person had to replace.",
  passes: "Every attachment path is outside /tmp and any scratchpad directory.",
  check(params) {
    const paths = [params.attachment_path, ...Array.isArray(params.attachment_paths) ? params.attachment_paths : []].filter(Boolean);
    const bad = paths.filter((x) => GENERATED_FILE_DIRS.test(String(x)));
    if (bad.length === 0) return null;
    return {
      rule: "NO_GENERATED_EVIDENCE",
      fields: ["attachment_path"],
      message: `${bad.join(", ")}: files in /tmp or a scratchpad are what scripts produce, not what a person supplied. Attach the person's own file (e.g. the Gmail print-to-PDF) from Downloads, Documents or data/attachments.`
    };
  }
});
function checkOrgPolicy(params) {
  const out = [];
  for (const rule of ORG_POLICY) {
    const v = rule.check(params);
    if (v) out.push(v);
  }
  return out;
}

// src/profile/profile.ts
import * as fs4 from "fs";
import * as path2 from "path";
var PROFILE_SCHEMA_VERSION = 1;
function emptyProfile(user) {
  return {
    schema_version: PROFILE_SCHEMA_VERSION,
    user,
    cards: [],
    budget_pots: [],
    updated_at: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function profileDir(home = process.env.IPK_HOME_DIR ?? process.env.HOME ?? "") {
  return path2.join(home, ".config", "ipk-browser-mcp");
}
function profilePath(home) {
  return path2.join(profileDir(home), "profile.json");
}
function loadProfile(home) {
  try {
    return JSON.parse(fs4.readFileSync(profilePath(home), "utf-8"));
  } catch {
    return null;
  }
}
function saveProfile(profile, home) {
  const dir = profileDir(home);
  fs4.mkdirSync(dir, { recursive: true });
  const p = profilePath(home);
  fs4.writeFileSync(p, JSON.stringify(profile, null, 2) + "\n", { mode: 384 });
  fs4.chmodSync(p, 384);
  return p;
}
function maskCardNumber(number) {
  const digits = number.replace(/\D/g, "");
  if (digits.length < 4) return "****";
  return `****-****-****-${digits.slice(-4)}`;
}
function cardDigits(number) {
  return number.replace(/\D/g, "");
}
function cardMatches(profileNumber, domValue) {
  const domDigits = cardDigits(domValue);
  if (!/[Xx]/.test(profileNumber)) {
    return cardDigits(profileNumber) === domDigits;
  }
  const groups = profileNumber.split(/[-\s]+/).filter(Boolean);
  const first = cardDigits(groups[0] ?? "");
  const last = cardDigits(groups[groups.length - 1] ?? "");
  if (!first || !last) return false;
  return domDigits.startsWith(first) && domDigits.endsWith(last) && domDigits.length >= first.length + last.length;
}
function fiscalYearFromCode(code) {
  const m = /^[A-Za-z]{2}(\d{2})/.exec(code);
  if (!m) return void 0;
  return 2e3 + Number(m[1]);
}

// src/policy/field-rules.ts
var FieldRulesUnavailable = class extends Error {
};
var HANGUL2 = /[ᄀ-ᇿ㄰-㆏ꥠ-꥿가-힯ힰ-퟿]/;
function toRegExp(pattern) {
  const m = /^\(\?i\)/.exec(pattern);
  return m ? new RegExp(pattern.slice(m[0].length), "i") : new RegExp(pattern);
}
function runCheck(c, rawValue) {
  const v = c.form_values?.[rawValue] ?? rawValue;
  switch (c.type) {
    case "pattern":
      if (!toRegExp(c.regex).test(v)) return `pattern /${c.regex}/ not matched`;
      return null;
    case "max_len":
      if (v.length > c.max) return `max_len ${c.max} exceeded (${v.length})`;
      return null;
    case "min_len":
      if (v.length < c.min) return `min_len ${c.min} not reached (${v.length})`;
      return null;
    case "english":
      if (HANGUL2.test(v)) return "english: contains Hangul";
      return null;
    case "one_of":
      if (!c.values.includes(v)) return `one_of: '${v}' not in ${JSON.stringify(c.values)}`;
      return null;
    case "fixed":
      if (v !== c.value) return `fixed: '${v}' != '${c.value}'`;
      return null;
  }
  return null;
}
function toValues(value) {
  return Array.isArray(value) ? value.map(String) : [String(value)];
}
var HARD_SELF_FIELD_CHECKS = {
  budget_code: (p, values) => values.every((v) => p.budget_pots.some((b) => b.code === v))
};
var CARD_SELF_FIELDS = /* @__PURE__ */ new Set(["card_no", "credit_card_no", "copcard"]);
function ownCardMatch(profile, values) {
  return values.every((v) => profile.cards.some((c) => c.kind === "own" && cardMatches(c.number, v)));
}
function unconfirmedOwnCardMatch(profile, values) {
  return values.every((v) => profile.cards.some((c) => c.kind === "own-unconfirmed" && cardMatches(c.number, v)));
}
function matchesSomeoneElsesCard(profile, values) {
  return values.some((v) => profile.cards.some((c) => c.kind === "shared" && cardMatches(c.number, v)));
}
var SOFT_SELF_FIELD_SOURCES = {
  approver: (p, env) => p?.approval_line?.group_leader ?? env?.IPK_GROUP_LEADER,
  substitute_name: (p, env) => p?.approval_line?.substitute ?? env?.IPK_SUBSTITUTE_NAME,
  emergency_address: (_p, env) => env?.IPK_EMERGENCY_ADDRESS,
  emergency_telephone: (_p, env) => env?.IPK_EMERGENCY_TELEPHONE
};
function checkFieldRules(book, draft, options = {}) {
  const fields = book.fields ?? {};
  const ignore = new Set(book.ignore ?? []);
  const unknownMode = options.unknownFields ?? "block";
  const blocks = [];
  const warnings = [];
  const unknown = Object.keys(draft).filter((k) => !(k in fields) && !ignore.has(k));
  if (unknown.length > 0) {
    if (unknownMode === "block") {
      throw new FieldRulesUnavailable(`${book.form}: no rule for field(s) ${unknown.join(", ")}. The draft was not checked.`);
    }
    const nonEmpty = unknown.filter((k) => toValues(draft[k]).some((v) => v !== ""));
    if (nonEmpty.length > 0) {
      warnings.push({
        field: nonEmpty.join(", "),
        scope: "unknown",
        message: `no rule for field(s) ${nonEmpty.join(", ")} - not checked against office/personal practice (the rulebook may not have caught up with this form field yet)`
      });
    }
  }
  const conditionals = book.conditional ?? [];
  const matched = conditionals.filter(
    (c) => c.when.field in draft && toValues(draft[c.when.field]).some((v) => toRegExp(c.when.regex).test(v))
  );
  const decided = new Set(matched.map((c) => c.then.field));
  for (const [name, value] of Object.entries(draft)) {
    const f = fields[name];
    if (!f || f.scope === "case" || decided.has(name)) continue;
    const values = toValues(value).filter((v) => v !== "");
    if (values.length === 0) continue;
    if (f.source) {
      if (f.scope === "self") {
        if (CARD_SELF_FIELDS.has(name)) {
          if (!options.profile) {
            blocks.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: no profile loaded - ask the person; run ipk_profile_init to read your own cards from the groupware.`
            });
          } else if (ownCardMatch(options.profile, values)) {
          } else if (unconfirmedOwnCardMatch(options.profile, values)) {
            warnings.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: this card appeared on only one of this person's own approved documents - not blocked, but unconfirmed (seen on <2 non-meeting approved AppFrm-021 docs). Re-run ipk_profile_init later to confirm it.`
            });
          } else {
            const message = matchesSomeoneElsesCard(options.profile, values) ? `${name} [self]: this card belongs to someone else - ask the person; a shared card is only allowed where an explicit rule names it (e.g. the Team Activities account conditional).` : `${name} [self]: value not found in the profile - ask the person; never fill a self field from someone else's precedent.`;
            blocks.push({ field: name, scope: f.scope, message });
          }
        } else if (name in HARD_SELF_FIELD_CHECKS) {
          const check = HARD_SELF_FIELD_CHECKS[name];
          if (!options.profile) {
            blocks.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: no profile loaded - ask the person; run ipk_profile_init to read your own cards/budget pots from the groupware.`
            });
          } else if (!check(options.profile, values)) {
            blocks.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: value not found in the profile - ask the person; never fill a self field from someone else's precedent.`
            });
          }
        } else if (name in SOFT_SELF_FIELD_SOURCES) {
          const configured = SOFT_SELF_FIELD_SOURCES[name](options.profile, options.env);
          if (configured === void 0) {
            warnings.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: not independently verifiable yet - configure profile.approval_line or the matching env var (see ipk-submit.ts) to check this field.`
            });
          } else if (!values.every((v) => v === configured)) {
            blocks.push({
              field: name,
              scope: f.scope,
              message: `${name} [self]: shows '${values.join(", ")}' but the configured value is '${configured}' - ask the person (this may be the wrong person on the document).`
            });
          }
        } else {
          warnings.push({
            field: name,
            scope: f.scope,
            message: `${name} [self]: no profile mapping defined for '${name}' yet - not verifiable, not blocked.`
          });
        }
      } else {
        warnings.push({
          field: name,
          scope: f.scope,
          message: `${name} [org]: no ${f.source} data available to check this field against office practice`
        });
      }
      continue;
    }
    for (const c of f.checks ?? []) {
      for (const v of values) {
        const msg = runCheck(c, v);
        if (msg) blocks.push({ field: name, scope: f.scope, message: `${name} [${f.scope}]: ${msg}${f.why ? ` - ${f.why}` : ""}` });
      }
    }
  }
  for (const c of matched) {
    if (c.then.field in draft) {
      const got = toValues(draft[c.then.field]).filter((g) => g !== "");
      const pattern = c.then.regex !== void 0 ? toRegExp(c.then.regex) : null;
      const mismatched = got.length > 0 && got.some(
        (g) => pattern ? !pattern.test(g) : (c.then.form_values?.[g] ?? g) !== c.then.value
      );
      if (mismatched) {
        const want = pattern ? `match /${c.then.regex}/` : `be '${c.then.value}'`;
        blocks.push({
          field: c.then.field,
          scope: fields[c.then.field]?.scope ?? "org",
          message: `${c.then.field}: must ${want} when ${c.when.field} matches /${c.when.regex}/${c.why ? ` - ${c.why}` : ""}`
        });
      }
    }
  }
  return { blocks, warnings };
}

// src/forms/travel-request.ts
var TRAVEL_DOC_SLOTS = {
  transport: "travel_doc_a[]",
  accommodation: "travel_doc_b[]",
  boarding: "travel_doc_c[]",
  etc: "travel_doc_d[]",
  verification: "travel_doc_e[]",
  poster: "travel_doc_f[]",
  general: "doc_attach_file[]"
};
function slotSelector(slot) {
  return `input[name="${TRAVEL_DOC_SLOTS[slot]}"]`;
}
function checkAttachmentSlot(p) {
  const out = [];
  if (p.attachment_path || Array.isArray(p.attachment_paths) && p.attachment_paths.length) {
    const slot = p.attachment_slot;
    const names = Object.keys(TRAVEL_DOC_SLOTS).join(", ");
    if (!slot) {
      out.push({
        code: "ATTACHMENT_SLOT_REQUIRED",
        fields: ["attachment_slot"],
        message: `this form has separate attachment rows (${names}). Say which one with attachment_slot; the file is not guessed into the first row.`
      });
    } else if (!(slot in TRAVEL_DOC_SLOTS)) {
      out.push({
        code: "ATTACHMENT_SLOT_UNKNOWN",
        fields: ["attachment_slot"],
        message: `attachment_slot '${slot}' is not a row on this form. Rows: ${names}.`
      });
    }
  }
  return out;
}
function parseCardNo(s) {
  const digits = String(s ?? "").replace(/[-\s]/g, "");
  if (!/^\d{16}$/.test(digits)) return null;
  return [digits.slice(0, 4), digits.slice(4, 8), digits.slice(8, 12), digits.slice(12, 16)];
}
function checkTravelRequestParams(p) {
  const out = [];
  const bound = p.bound_code == null ? "" : String(p.bound_code);
  const hasProvince = !!(p.province_code || p.city_code);
  if (bound === "19") {
    if (hasProvince) {
      out.push({
        code: "BOUND_HIDES_PROVINCE",
        fields: ["bound_code", "province_code", "city_code"],
        message: "bound_code '19' (within metro) hides and clears province_code/city_code; the document would show only 'Within Metropolitan'. Use bound_code '20' to name a province and city."
      });
    }
    if (p.working_code && String(p.working_code) !== "197") {
      out.push({
        code: "BOUND_FORCES_WORKING_CODE",
        fields: ["bound_code", "working_code"],
        message: `bound_code '19' forces working_code to '197'; '${p.working_code}' would be overwritten. Omit working_code or use '197'.`
      });
    }
  } else if (bound === "20") {
    if (!(p.province_code && p.city_code && p.travel_type_code)) {
      out.push({
        code: "BOUND_NEEDS_PROVINCE",
        fields: ["province_code", "city_code", "travel_type_code"],
        message: "bound_code '20' (out of metro) requires province_code, city_code and travel_type_code; the form refuses without them."
      });
    }
    if (p.meals_served == null || p.meals_served === "") {
      out.push({
        code: "MEALS_REQUIRED",
        fields: ["meals_served"],
        message: "bound_code '20' asks whether meals are provided on the trip. Pass meals_served: 'N', or the number of meals served (1-30)."
      });
    } else if (!(String(p.meals_served) === "N" || /^([1-9]|[12]\d|30)$/.test(String(p.meals_served)))) {
      out.push({
        code: "MEALS_MALFORMED",
        fields: ["meals_served"],
        message: `meals_served must be 'N' or a count 1-30, not '${p.meals_served}'.`
      });
    }
    if (p.working_code) {
      out.push({
        code: "BOUND_HIDES_WORKING_CODE",
        fields: ["bound_code", "working_code"],
        message: "bound_code '20' hides working_code; a value set there is not part of the document. Omit it."
      });
    }
  }
  out.push(...checkAttachmentSlot(p));
  if (p.credit_card_no != null && p.credit_card_no !== "" && !parseCardNo(String(p.credit_card_no))) {
    out.push({
      code: "CARD_NO_MALFORMED",
      fields: ["credit_card_no"],
      message: "credit_card_no must be 16 digits (e.g. 1234-5678-9012-3456)."
    });
  }
  return out;
}

// src/forms/working.ts
function parseDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = /* @__PURE__ */ new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
function isoWeekKey(date) {
  const d = parseDate(date);
  if (!d) return `invalid:${date}`;
  const t = new Date(d.getTime());
  const dayNum = (t.getUTCDay() + 6) % 7;
  t.setUTCDate(t.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((t.getTime() - firstThursday.getTime()) / (7 * 864e5));
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
function isWeekend(date) {
  const d = parseDate(date);
  if (!d) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
function checkWorkingRows(rows) {
  const violations = [];
  const warnings = [];
  if (!rows || rows.length === 0) {
    violations.push({ code: "MISSING_ROWS", message: "At least one {date, hours} row is required.", fields: ["rows"] });
    return { violations, warnings };
  }
  const weekTotals = /* @__PURE__ */ new Map();
  rows.forEach((row, i) => {
    const field = `rows[${i}]`;
    if (!Number.isInteger(row.hours) || row.hours < 1 || row.hours > 12) {
      violations.push({
        code: "HOURS_OUT_OF_RANGE",
        message: `${field}: hours must be a whole number from 1 to 12 (the form's working_time[] select only offers 01:00-12:00) - got ${row.hours}.`,
        fields: [field]
      });
    }
    const d = parseDate(row.date);
    if (!d) {
      violations.push({ code: "INVALID_DATE", message: `${field}: date '${row.date}' is not a valid YYYY-MM-DD date.`, fields: [field] });
      return;
    }
    if (!isWeekend(row.date)) {
      warnings.push({
        code: "WEEKDAY_DATE",
        message: `${field}: ${row.date} is a weekday. This form is for weekend/holiday work - if it's a public holiday that's fine, but there is no holiday calendar here to confirm it.`,
        fields: [field]
      });
    }
    if (Number.isFinite(row.hours)) {
      const key = isoWeekKey(row.date);
      weekTotals.set(key, (weekTotals.get(key) ?? 0) + row.hours);
    }
  });
  for (const [week, total] of weekTotals) {
    if (total > 12) {
      violations.push({
        code: "WEEKLY_CAP_EXCEEDED",
        message: `Total working hours for ISO week ${week} is ${total}, over the department's 12-hour/week cap.`,
        fields: ["rows"]
      });
    }
  }
  return { violations, warnings };
}

// src/forms/travel-report.ts
var REPORT_CONTENT_FIELDS = ["purpose_field", "agenda_field", "result_field", "discuss_field", "conclusion_field"];
function reportIsEmpty(fields) {
  return REPORT_CONTENT_FIELDS.every((k) => !(fields[k] ?? "").trim());
}
async function readReportContentFields(frame) {
  return frame.evaluate((names) => {
    const out = {};
    for (let i = 0; i < names.length; i++) {
      const el = document.querySelector(`[name="${names[i]}"]`);
      out[names[i]] = el ? el.value : "";
    }
    return out;
  }, REPORT_CONTENT_FIELDS);
}
function pickApprovedTravelRequest(hrefs) {
  const relevant = hrefs.filter((h) => /approve_type=AppFrm-023\b/.test(h) || /approve_type=AppFrm-026\b/.test(h));
  if (relevant.length === 0) {
    return { error: "no approved travel request found for this person in the lookup window", candidates: 0 };
  }
  if (relevant.length > 1) {
    return { error: `${relevant.length} approved travel requests matched - pass request_doc_id explicitly to pick one`, candidates: relevant.length };
  }
  const href = relevant[0];
  const docId = (href.match(/doc_id=(\d+)/) ?? [])[1];
  if (!docId) {
    return { error: "matched one approved travel request but could not read its doc_id from the link", candidates: 1 };
  }
  const formCode = /approve_type=AppFrm-026\b/.test(href) ? "AppFrm-026" : "AppFrm-023";
  return { docId, formCode };
}
async function findOwnApprovedTravelRequest(page, opts) {
  const origin = new URL(opts.baseUrl).origin;
  const ymd2 = (d) => d.toISOString().slice(0, 10);
  const e = /* @__PURE__ */ new Date();
  const s = new Date(e.getTime() - (opts.sinceDays ?? 365) * 864e5);
  const listUrl = `${origin}/Document/document_list.php?type=approved&s_date=${ymd2(s)}&e_date=${ymd2(e)}&keyword=${encodeURIComponent(opts.keyword ?? "")}&writer=Y&title=Y&contents=Y&attachment=Y`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 3e4 });
  await page.waitForTimeout(1500);
  const hrefs = await page.mainFrame().$$eval("a[href*='doc_id=']", (as) => as.map((a) => a.getAttribute("href") || ""));
  const relevant = hrefs.filter((h) => /approve_type=AppFrm-023\b/.test(h) || /approve_type=AppFrm-026\b/.test(h));
  if (relevant.length === 0) {
    return { error: "no approved travel request found for this person in the lookup window", candidates: 0 };
  }
  const withEmptyReport = [];
  for (const href of relevant) {
    if (/approve_type=AppFrm-026\b/.test(href)) {
      withEmptyReport.push(href);
      continue;
    }
    const docId = (href.match(/doc_id=(\d+)/) ?? [])[1];
    if (!docId) continue;
    await page.goto(`${origin}/Document/travel_report_write.php?doc_id=${encodeURIComponent(docId)}&approve_type=AppFrm-023&pop=Y`, {
      waitUntil: "domcontentloaded",
      timeout: 3e4
    });
    await page.waitForTimeout(1200);
    const current = await readReportContentFields(page.mainFrame());
    if (reportIsEmpty(current)) withEmptyReport.push(href);
  }
  if (withEmptyReport.length === 0) {
    return {
      error: `${relevant.length} approved travel request(s) found, but every one already has a report written - pass request_doc_id explicitly (with overwrite_report: true to replace one)`,
      candidates: relevant.length
    };
  }
  return pickApprovedTravelRequest(withEmptyReport);
}
function buildDomesticReportFields(params, userInfo, env, today) {
  const purpose = params.purpose || "Business travel";
  return {
    report_date: today,
    report_name: userInfo.name,
    report_post: env.reportPost || "",
    report_group: env.userDept || userInfo.dept || "",
    report_leader: env.reportLeader || "",
    purpose_field: String(purpose),
    date_field: params.schedule || "",
    org_field: params.organization || params.destination || "",
    person_field: params.persons_met || "",
    discuss_field: params.details || purpose,
    agenda_field: params.schedule || purpose,
    result_field: params.reason || `Expected outcomes: ${purpose}`,
    other_field: "N/A",
    conclusion_field: String(purpose)
  };
}

// src/precedent/travel-request-doc.ts
var SLOT_LABELS = [
  [/^Transport$/, "transport"],
  [/^Accommodation$/, "accommodation"],
  [/^Boarding Pass/, "boarding"],
  [/^ETC \(Visa/, "etc"],
  [/^Business trip verification/, "verification"],
  [/^Poster$/, "poster"],
  [/^Travel Report$/, "report"]
];
var norm = (s) => s.replace(/\s+/g, " ").trim();
function parseTravelRequestDoc(text) {
  const lines = text.split("\n").map(norm);
  const doc = { attachments: [], labels_found: 0 };
  const after = (label) => {
    const l = lines.find((x) => x.startsWith(label + " "));
    if (l) doc.labels_found++;
    return l ? l.slice(label.length + 1).trim() : void 0;
  };
  doc.subject = after("Subject");
  const budget = lines.find((x) => x.startsWith("Budget Account Code"));
  if (budget) doc.labels_found++;
  const codes = budget ? [...budget.matchAll(/\[([A-Z]{2}\d{4}-\d{4})\]/g)].map((m) => m[1]) : [];
  if (codes.length) doc.budget_code = codes[codes.length - 1];
  const card = after("Institute Credit Card No");
  if (card && /[\dX]{4}-[\dX]{4}-[\dX]{4}-[\dX]{4}/.test(card)) doc.credit_card_no = card;
  const cityLine = after("City & Transportation");
  if (cityLine) {
    const parts = cityLine.split(" - ").map(norm);
    if (parts.length >= 3) {
      doc.bound = "out";
      [doc.province, doc.city, doc.transport] = parts;
    } else {
      doc.bound = /Metropolitan/.test(cityLine) ? "in" : void 0;
      doc.transport = parts[parts.length - 1];
    }
  }
  doc.purpose_type = after("Type of Business Travel");
  const daily = lines.find((x) => /^Daily Expense \d/.test(x));
  if (daily) doc.daily_expense = Number(daily.split(" ")[2]);
  const food = lines.find((x) => /^Food Expense \d/.test(x));
  if (food) doc.food_allowance = Number(food.split(" ")[2]);
  let slot = null;
  for (const l of lines) {
    const hit = SLOT_LABELS.find(([re]) => re.test(l));
    if (hit) {
      slot = hit[1];
      continue;
    }
    if (slot && /\[\d+Bytes\]/.test(l)) {
      doc.attachments.push({ slot, file: l.replace(/\s*\[\d+Bytes\].*$/, "") });
    } else if (slot && l) {
      slot = null;
    }
  }
  return doc;
}
var PRACTICE_FIELDS = ["budget_code", "bound", "province", "city", "transport", "purpose_type", "food_allowance"];
function practiceProfile(docs) {
  const out = { stable: {}, varied: {}, n: docs.length };
  if (docs.length < 2) return out;
  const tally = (key, values) => {
    const seen = values.filter((v) => v != null && v !== "");
    if (seen.length !== docs.length) {
      if (seen.length) out.varied[key] = count(seen);
      return;
    }
    const c = count(seen);
    const keys = Object.keys(c);
    if (keys.length === 1) out.stable[key] = { value: keys[0], n: docs.length };
    else out.varied[key] = c;
  };
  for (const f of PRACTICE_FIELDS) tally(f, docs.map((d) => d[f] == null ? void 0 : String(d[f])));
  tally("credit_card_no", docs.map((d) => d.credit_card_no ? "present" : "absent"));
  tally(
    "attachment_slot",
    docs.map((d) => {
      const slots = [...new Set(d.attachments.map((a) => a.slot))];
      return slots.length === 1 ? slots[0] : void 0;
    })
  );
  return out;
}
function count(xs) {
  const c = {};
  for (const x of xs) c[x] = (c[x] ?? 0) + 1;
  return c;
}

// src/precedent/fetch.ts
var ymd = (d) => d.toISOString().slice(0, 10);
async function fetchTravelRequestPrecedents(page, q) {
  const n = q.n ?? 3;
  const origin = new URL(q.baseUrl).origin;
  const excluded = toolDraftedDocIds();
  const out = { docs: [], excluded: [], profile: practiceProfile([]) };
  try {
    const e = /* @__PURE__ */ new Date();
    const s = new Date(e.getTime() - (q.sinceDays ?? 365) * 864e5);
    const listUrl = `${origin}/Document/document_list.php?type=groupapproved&s_date=${ymd(s)}&e_date=${ymd(e)}&keyword=${encodeURIComponent(q.keyword ?? "")}&writer=Y&title=Y&contents=Y&attachment=Y`;
    await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 3e4 });
    await page.waitForTimeout(1500);
    const rows = await page.mainFrame().$$eval(
      "tr",
      (trs) => trs.map((r) => {
        const a = r.querySelector("a[href*='doc_id=']");
        if (!a) return null;
        const href = a.getAttribute("href") || "";
        const m = href.match(/doc_id=(\d+)/);
        const cells = Array.from(r.querySelectorAll("td")).map((td) => (td.innerText || "").replace(/\s+/g, " ").trim());
        return { href, docId: m ? m[1] : "", docNo: cells[0] ?? "", subject: cells[1] ?? "", writer: cells[3] ?? "" };
      }).filter(Boolean)
    );
    const ofForm = rows.filter((r) => r.href.includes(`approve_type=${q.formCode}`) && r.docId);
    const mine = q.writer ? ofForm.filter((r) => r.writer === q.writer) : [];
    const ordered = [...mine, ...ofForm.filter((r) => !mine.includes(r))];
    const picked = [];
    for (const r of ordered) {
      if (excluded.has(r.docId)) {
        out.excluded.push(r.docId);
        continue;
      }
      if (picked.length < n) picked.push(r);
    }
    for (const r of picked) {
      await page.goto(new URL(r.href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: 3e4 });
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => document.body.innerText);
      out.docs.push({ docId: r.docId, docNo: r.docNo, writer: r.writer, doc: parseTravelRequestDoc(text) });
    }
    const unreadable = out.docs.filter((d) => d.doc.labels_found === 0).map((d) => d.docId);
    if (unreadable.length) out.error = `could not read fields off document(s) ${unreadable.join(", ")}: the view did not render as a label/value table`;
    out.profile = practiceProfile(out.docs.filter((d) => d.doc.labels_found > 0).map((d) => d.doc));
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }
  return out;
}
async function readDraftText(page, baseUrl, docId) {
  const origin = new URL(baseUrl).origin;
  await page.goto(`${origin}/Document/document_list.php?type=drafts`, { waitUntil: "domcontentloaded", timeout: 3e4 });
  await page.waitForTimeout(1500);
  const href = await page.mainFrame().$eval(`a[href*='doc_id=${docId}']`, (a) => a.getAttribute("href")).catch(() => null);
  if (!href) return { text: null, reason: `draft ${docId} is not on the first page of the drafts list` };
  await page.goto(new URL(href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: 3e4 });
  await page.waitForTimeout(1500);
  return { text: await page.evaluate(() => document.body.innerText) };
}
function diffAgainstPractice(draft, profile) {
  const out = [];
  const draftSlot = [...new Set(draft.attachments.map((a) => a.slot))];
  const value = (field) => {
    if (field === "attachment_slot") return draftSlot.length === 1 ? draftSlot[0] : draftSlot.join("+") || void 0;
    if (field === "credit_card_no") return draft.credit_card_no ? "present" : "absent";
    const v = draft[field];
    return v == null ? void 0 : String(v);
  };
  for (const [field, st] of Object.entries(profile.stable)) {
    const d = value(field);
    if (d !== st.value) out.push({ field, draft: d, practice: st.value, n: st.n });
  }
  return out;
}

// src/forms/card-er-authorization.ts
import * as fs5 from "fs";
import * as path3 from "path";
function cardErAuthorizationPath(home) {
  return path3.join(profileDir(home), "card-er-draft-authorizations.json");
}
function readCardErDraftAuthorizations(file = cardErAuthorizationPath()) {
  try {
    const v = JSON.parse(fs5.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}
function findCardErDraftAuthorization(auths, apprNo, trseq) {
  const key = String(apprNo ?? "");
  const want = String(trseq ?? "");
  if (!key || !want || !Object.prototype.hasOwnProperty.call(auths, key)) return null;
  const entry = auths[key];
  if (!entry || typeof entry !== "object" || typeof entry.trseq !== "string") return null;
  return entry.trseq === want ? entry : null;
}
function removeEntry(auths, key, file) {
  const rest = { ...auths };
  delete rest[key];
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs5.writeFileSync(tmp, JSON.stringify(rest, null, 2) + "\n", { mode: 384 });
    fs5.renameSync(tmp, file);
  } finally {
    fs5.rmSync(tmp, { force: true });
  }
}
function consumeCardErDraftAuthorization(apprNo, trseq, file = cardErAuthorizationPath()) {
  const auths = readCardErDraftAuthorizations(file);
  const entry = findCardErDraftAuthorization(auths, apprNo, trseq);
  if (!entry) return null;
  removeEntry(auths, String(apprNo), file);
  return entry;
}
function findCardErDocEditAuthorization(auths, docId) {
  const id = String(docId ?? "");
  const key = `doc:${id}`;
  if (!id || !Object.prototype.hasOwnProperty.call(auths, key)) return null;
  const entry = auths[key];
  if (!entry || typeof entry !== "object" || entry.doc_id !== id) return null;
  return entry;
}
function consumeCardErDocEditAuthorization(docId, file = cardErAuthorizationPath()) {
  const auths = readCardErDraftAuthorizations(file);
  const entry = findCardErDocEditAuthorization(auths, docId);
  if (!entry) return null;
  removeEntry(auths, `doc:${String(docId)}`, file);
  return entry;
}

// src/browser/card-er-location.ts
function detectSubmittedOnDocumentView(bodyText) {
  const found = [];
  if (/Approval\s*>\s*Progress/.test(bodyText)) found.push("Approval > Progress");
  if (/Document\s+Repossess/i.test(bodyText)) found.push("Document Repossess");
  return found;
}

// src/browser/draft-guard.ts
function listHasDoc(html, docId) {
  if (!/^\d+$/.test(String(docId))) return false;
  return new RegExp(`(?<![\\w])doc_id=['"]?${docId}(?!\\d)`).test(html);
}
function classifyDocLocation(inDrafts, inProgress) {
  if (inDrafts) return "drafts";
  if (inProgress) return "progress";
  return "neither";
}
function applyDraftGuard(payload, docId, location2, reason) {
  const data = payload.data ?? {};
  if (location2 === "drafts") {
    return {
      ...payload,
      data: { ...data, draft_confirmed: true, message: `${data.message ?? "Draft saved"} - confirmed in Drafts` }
    };
  }
  if (location2 === "progress") {
    return {
      error: true,
      code: "SUBMITTED_NOT_DRAFT",
      message: `Document ${docId} was SUBMITTED for approval, not saved as a draft. Repossess it from the document view ([ Document Repossess ]) before an approver acts.`,
      docId,
      data: { ...data, draft_confirmed: false }
    };
  }
  return {
    error: true,
    code: "DRAFT_NOT_CONFIRMED",
    message: `Document ${docId} was not found in Drafts or In Progress (first page of each)${reason ? ` - ${reason}` : ""}. It may or may not have been saved, or it may have been submitted - check the document lists before retrying.`,
    docId,
    data: { ...data, draft_confirmed: false }
  };
}
function draftViewUrl(origin, docId, listHtml, viewUrl) {
  if (viewUrl && new RegExp(`[?&]doc_id=${docId}(?!\\d)`).test(viewUrl)) return viewUrl;
  const href = listHtml.match(new RegExp(`document_view\\.php\\?[^"'\\s>]*(?<![\\w])doc_id=${docId}(?!\\d)[^"'\\s>]*`));
  const code = href ? href[0].replace(/&amp;/g, "&").match(/[?&]approve_type=([\w-]+)/) : null;
  return `${origin}/Document/document_view.php?doc_id=${docId}${code ? `&approve_type=${code[1]}` : ""}&type=drafts`;
}
async function locateDocument(page, baseUrl, docId, timeoutMs = 3e4, viewUrl) {
  const origin = new URL(baseUrl).origin;
  const listHtml = async (type) => {
    await page.goto(`${origin}/Document/document_list.php?type=${type}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(1e3);
    return String(await page.content());
  };
  let landing = origin;
  try {
    const draftsHtml = await listHtml("drafts");
    const inDrafts = listHasDoc(draftsHtml, docId);
    if (inDrafts) landing = draftViewUrl(origin, docId, draftsHtml, viewUrl);
    const inProgress = inDrafts ? false : listHasDoc(await listHtml("progress"), docId);
    return { location: classifyDocLocation(inDrafts, inProgress) };
  } catch (err) {
    return { location: "neither", reason: `the lists could not be read: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    await page.goto(landing, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => null);
  }
}
async function confirmDraftResult(page, baseUrl, mode, result, timeoutMs) {
  if (mode !== "draft") return result;
  let payload;
  try {
    payload = JSON.parse(result?.content?.[0]?.text ?? "");
  } catch {
    return result;
  }
  const docId = payload?.data?.docId;
  if (payload.error || !docId) return result;
  const viewUrl = typeof payload.data.finalUrl === "string" ? payload.data.finalUrl : void 0;
  const { location: location2, reason } = await locateDocument(page, baseUrl, String(docId), timeoutMs, viewUrl);
  if (location2 !== "drafts") {
    audit({ action: "refusal", code: location2 === "progress" ? "SUBMITTED_NOT_DRAFT" : "DRAFT_NOT_CONFIRMED", docId: String(docId), mode, ok: false });
  }
  return textResult(applyDraftGuard(payload, String(docId), location2, reason));
}

// src/types.ts
var LEAVE_TYPES = {
  annual: "01",
  sick: "02",
  special: "03",
  menstruation: "04",
  official: "05",
  childcare: "07",
  unpaid: "08",
  childcare_hours: "09",
  temporary_suspension: "10",
  compensatory: "11",
  other: "12",
  fetus_checkup: "13",
  saved_annual: "14",
  paternity: "15"
};
var ATTACHMENT_REQUIRED_LEAVES = {
  "02": "\uC9C4\uB2E8\uC11C/\uC785\uC6D0\uD655\uC778\uC11C",
  "03": "\uC99D\uBE59\uC11C\uB958",
  "05": "\uC99D\uBE59\uC11C\uB958",
  "07": "\uC99D\uBE59\uC11C\uB958",
  "13": "\uC99D\uBE59\uC11C\uB958",
  "15": "\uCD9C\uC0DD\uC99D\uBA85\uC11C"
};
var FORM_CODES = {
  leave: "AppFrm-073",
  expense: "AppFrm-020",
  // Fixed: was AppFrm-021 (incorrect form code)
  working: "AppFrm-074",
  travel: "AppFrm-076",
  travel_request: "AppFrm-023",
  budget_transfer: "AppFrm-039",
  // Wave 2 form types
  travel_settlement: "AppFrm-054",
  leave_return: "AppFrm-028",
  card_expense: "AppFrm-020",
  card_expense_rd: "AppFrm-021",
  seminar: "AppFrm-043",
  overseas_travel: "AppFrm-026"
};
var BUDGET_TRANSFER_CODES = {
  rnd: "AppFrm-039",
  general: "AppFrm-053"
};
var LEAVE_NAMES = {
  annual: "Annual leave",
  sick: "Sick leave",
  special: "Special leave",
  menstruation: "Menstruation leave",
  official: "Official leave",
  childcare: "Child delivery and Nursing leave",
  unpaid: "Unpaid leave",
  childcare_hours: "Childcare hours",
  temporary_suspension: "Temporary suspension",
  compensatory: "Compensatory leave",
  other: "Other leave",
  fetus_checkup: "Fetus Checkup",
  saved_annual: "Saved annual leave",
  paternity: "Paternity Leave"
};
var CONFIG_DIR = `${process.env.HOME}/.config/ipk-browser-mcp`;
var ENV_FILE = `${CONFIG_DIR}/.env`;

// src/browser/iframe-helper.ts
function getMainFrame(page) {
  return page.frame("main_menu");
}
var FORM_READY_SELECTORS = {
  leave: 'select[name="leave_kind[]"]',
  travel_request: 'input[name="subject"]',
  travel: 'input[name="subject"]',
  seminar: 'input[name="subject"]'
};
var FORM_READY_DEFAULT = 'input[name="subject"]';
async function navigateToForm(page, formType, config) {
  const formCode = FORM_CODES[formType];
  if (!formCode) return null;
  const origin = new URL(config.baseUrl).origin;
  const formUrl = `${origin}/Document/document_write.php?approve_type=${formCode}`;
  await page.goto(formUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  const frame = page.mainFrame();
  if (formType === "expense") {
    await frame.waitForSelector('input[name="subject"]', { timeout: 8e3 });
    await frame.waitForSelector('select[name="account_code"]', { timeout: 8e3 }).catch(() => null);
  } else {
    const readySelector = FORM_READY_SELECTORS[formType] ?? FORM_READY_DEFAULT;
    await frame.waitForSelector(readySelector, { timeout: 8e3 }).catch(() => null);
  }
  return frame;
}
async function navigateInFrame(page, url, config) {
  const frame = getMainFrame(page);
  if (!frame) return null;
  const origin = new URL(config.baseUrl).origin;
  let fullUrl;
  if (url.startsWith("http")) {
    const parsed = new URL(url);
    if (parsed.hostname !== new URL(config.baseUrl).hostname) {
      throw new Error(`Navigation restricted to groupware domain (${new URL(config.baseUrl).hostname}). Rejected: ${parsed.hostname}`);
    }
    fullUrl = url;
  } else {
    fullUrl = `${origin}${url.startsWith("/") ? "" : "/"}${url}`;
  }
  await frame.goto(fullUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  return frame;
}
async function setFieldValue(frame, selector, value) {
  await frame.waitForSelector(selector, { state: "attached", timeout: 5e3 }).catch(() => null);
  const outcome = await frame.evaluate(
    (args) => {
      const el = document.querySelector(args.sel);
      if (!el) return "not_found";
      if (el.disabled) return "disabled";
      const hidden = el.getBoundingClientRect().width === 0 && el.getBoundingClientRect().height === 0;
      el.value = args.val;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return hidden ? "ok_hidden" : "ok";
    },
    { sel: selector, val: value }
  );
  if (outcome === "disabled") {
    audit({ action: "refusal", field: selector, code: "FIELD_DISABLED", ok: false });
    throw new Error(
      `FIELD_DISABLED: '${selector}' is disabled; the browser would not submit a value written to it. Enable it through the form's own controls instead.`
    );
  }
  audit({ action: "field_write", field: selector, value, hidden: outcome === "ok_hidden", ok: outcome !== "not_found" });
  return outcome !== "not_found";
}
async function setSelectValue(frame, selector, value) {
  const el = await frame.waitForSelector(selector, { state: "attached", timeout: 5e3 }).catch(() => null);
  if (!el) return false;
  const outcome = await frame.evaluate(
    (args) => {
      const el2 = document.querySelector(args.sel);
      if (!el2) return "not_found";
      if (el2.disabled) return "disabled";
      const offered = Array.from(el2.options).map((o) => o.value);
      if (args.val !== "" && !offered.includes(args.val)) {
        return { status: "no_option", offered };
      }
      const hidden = el2.getBoundingClientRect().width === 0 && el2.getBoundingClientRect().height === 0;
      el2.value = args.val;
      el2.dispatchEvent(new Event("change", { bubbles: true }));
      const label = el2.options[el2.selectedIndex]?.text?.trim() || "";
      return { status: hidden ? "ok_hidden" : "ok", label };
    },
    { sel: selector, val: value }
  );
  if (outcome === "disabled") {
    audit({ action: "refusal", field: selector, code: "FIELD_DISABLED", ok: false });
    throw new Error(
      `FIELD_DISABLED: '${selector}' is disabled; the browser would not submit a value written to it. Enable it through the form's own controls instead.`
    );
  }
  if (typeof outcome === "object" && outcome.status !== "no_option") {
    audit({
      action: "option_select",
      field: selector,
      value,
      label: outcome.label,
      fromOfferedOptions: true,
      hidden: outcome.status === "ok_hidden",
      ok: true
    });
    return true;
  }
  if (typeof outcome === "object" && outcome.status === "no_option") {
    audit({ action: "refusal", field: selector, code: "INVALID_OPTION", fromOfferedOptions: false, ok: false });
    throw new Error(
      `INVALID_OPTION: '${value}' is not an option '${selector}' offers. Allowed: ${outcome.offered.filter(Boolean).join(", ") || "(none yet - the form may fill this from another field first)"}`
    );
  }
  audit({ action: "option_select", field: selector, value, fromOfferedOptions: true, ok: outcome !== "not_found" });
  return outcome !== "not_found";
}
async function setRequiredField(frame, selector, value, fieldName) {
  const ok = await setFieldValue(frame, selector, value);
  if (!ok) {
    throw new Error(`FIELD_NOT_FOUND: Required field '${fieldName}' not found (selector: ${selector})`);
  }
}
async function setRequiredSelect(frame, selector, value, fieldName) {
  const ok = await setSelectValue(frame, selector, value);
  if (!ok) {
    throw new Error(`FIELD_NOT_FOUND: Required select '${fieldName}' not found (selector: ${selector})`);
  }
}
async function setFormMode(frame, mode) {
  const values = await frame.evaluate(
    (m) => {
      const els = Array.from(document.getElementsByName("mode1"));
      for (const el of els) el.value = m;
      return els.map((el) => el.value);
    },
    mode
  );
  const ok = Array.isArray(values) && values.length > 0 && values.every((v) => v === mode);
  audit({ action: "submit", mode, ok });
  if (!ok) {
    throw new Error(`setFormMode: mode1 did not read back '${mode}' (got ${JSON.stringify(values)}); stopped before the form's own submit`);
  }
}
async function submitForm(page, frame, method = "check_form_request") {
  const dialogs = [];
  const onDialog = (d) => {
    dialogs.push(d.message().replace(/\s+/g, " ").trim());
    d.accept().catch(() => {
    });
  };
  page.on("dialog", onDialog);
  try {
    if (method === "check_form_request") {
      await Promise.all([
        page.waitForNavigation({ timeout: 15e3, waitUntil: "load" }).catch(() => null),
        frame.evaluate(() => {
          window.Check_Form_Request("insert");
        })
      ]);
    } else {
      await Promise.all([
        page.waitForNavigation({ timeout: 2e4, waitUntil: "load" }).catch(() => null),
        frame.evaluate(() => {
          document.form1.submit();
        })
      ]);
    }
    try {
      await frame.waitForURL("**/document_view.php**", { timeout: 1e4 });
    } catch {
      await page.waitForTimeout(3e3);
    }
    const frameUrl = frame.url();
    if (frameUrl.includes("document_view.php") && frameUrl.includes("doc_id=")) {
      const match = frameUrl.match(/doc_id=([^&]+)/);
      const docId = match ? match[1] : null;
      audit({ action: "submit", docId, ok: true });
      return docId;
    }
    if (frameUrl.includes("document_write.php")) {
      throw new Error(
        dialogs.length ? `SUBMIT_REJECTED: the form refused the submission - ${dialogs.join(" / ")}` : "SUBMIT_FAILED: Form submission did not redirect and the form gave no message."
      );
    }
    throw new Error(
      `SUBMIT_UNVERIFIED: after submitting, the page is at ${frameUrl || "(unknown)"} and no document id came back. The document may or may not have been created - check the drafts list before retrying.` + (dialogs.length ? ` The form said: ${dialogs.join(" / ")}` : "")
    );
  } finally {
    page.off("dialog", onDialog);
  }
}
async function serializeFormFields(frame, knownNames) {
  return frame.evaluate((known) => {
    const knownSet = new Set(known);
    const out = {};
    const els = document.querySelectorAll("input[name], select[name], textarea[name]");
    els.forEach((raw) => {
      const el = raw;
      if (el.disabled) return;
      const name = el.name;
      if (!name) return;
      const type = el.type;
      if (type === "hidden" && !knownSet.has(name)) return;
      if ((type === "checkbox" || type === "radio") && !el.checked) return;
      const value = el.value;
      if (name.endsWith("[]")) {
        out[name] ??= [];
        out[name].push(value);
      } else {
        out[name] = value;
      }
    });
    return out;
  }, knownNames);
}
async function submitTravelReportDraft(page, frame) {
  const dialogs = [];
  const onDialog = (d) => {
    dialogs.push(d.message().replace(/\s+/g, " ").trim());
    d.accept().catch(() => {
    });
  };
  page.on("dialog", onDialog);
  try {
    await frame.evaluate(() => {
      window.Check_Form("D");
    });
    await page.waitForTimeout(1500);
  } finally {
    page.off("dialog", onDialog);
  }
  return { dialogs };
}

// src/tools/ipk-submit.ts
import * as path4 from "path";
import { fileURLToPath } from "url";

// src/form-registry.ts
var FORM_REGISTRY = {
  leave: { appFrmCode: "AppFrm-073", templateFile: "AppFrm-073.json", status: "implemented", description: "\uD734\uAC00\uC2E0\uCCAD" },
  expense: { appFrmCode: "AppFrm-020", templateFile: "AppFrm-020.json", status: "implemented", description: "\uACBD\uBE44\uC9C0\uCD9C" },
  working: { appFrmCode: "AppFrm-074", templateFile: "AppFrm-074.json", status: "implemented", description: "\uD734\uC77C\uADFC\uBB34" },
  travel: { appFrmCode: "AppFrm-076", templateFile: "AppFrm-076.json", status: "implemented", description: "\uCD9C\uC7A5\uBCF4\uACE0" },
  travel_request: { appFrmCode: "AppFrm-023", templateFile: "AppFrm-023.json", status: "implemented", description: "\uCD9C\uC7A5\uC2E0\uCCAD" },
  budget_transfer: { appFrmCode: "AppFrm-039", templateFile: "AppFrm-039.json", status: "implemented", description: "\uC608\uC0B0\uC804\uC6A9(R&D)" },
  // Wave 2 form types (implemented)
  travel_settlement: { appFrmCode: "AppFrm-054", templateFile: "AppFrm-054.json", status: "implemented", description: "\uCD9C\uC7A5\uC815\uC0B0" },
  leave_return: { appFrmCode: "AppFrm-028", templateFile: "AppFrm-028.json", status: "implemented", description: "\uB300\uCCB4\uD734\uC77C\uBC18\uB0A9" },
  card_expense: { appFrmCode: "AppFrm-020", templateFile: "AppFrm-020.json", status: "implemented", description: "\uCE74\uB4DC\uACBD\uBE44" },
  card_expense_rd: { appFrmCode: "AppFrm-021", templateFile: "AppFrm-021.json", status: "implemented", description: "R&D \uCE74\uB4DC\uACBD\uBE44 (mker)" },
  seminar: { appFrmCode: "AppFrm-043", templateFile: "AppFrm-043.json", status: "implemented", description: "\uC138\uBBF8\uB098\uACF5\uC2DC" },
  overseas_travel: { appFrmCode: "AppFrm-026", templateFile: "AppFrm-026.json", status: "implemented", description: "\uD574\uC678\uCD9C\uC7A5" }
};

// src/tools/ipk-submit.ts
var __filename = fileURLToPath(import.meta.url);
var __dirname = path4.dirname(__filename);
async function executePostActions(frame, actions) {
  for (const act of actions) {
    if (act.action === "wait_selector" && act.target) {
      await frame.waitForSelector(act.target, { timeout: 5e3 }).catch(() => null);
    } else if (act.action === "click_button" && act.target) {
      await frame.locator(act.target).click().catch(() => null);
    } else if (act.action === "assert_value" && act.target && act.value) {
      const actual = await frame.evaluate(
        (args) => {
          const el = document.querySelector(args.sel);
          return el ? el.value : null;
        },
        { sel: act.target }
      ).catch(() => null);
      if (actual !== act.value) {
        console.warn(`[genericFillForm] assert_value failed: ${act.target} expected "${act.value}" got "${actual}"`);
      }
    }
  }
}
async function verifyIntendedValues(frame, intended) {
  if (intended.length === 0) return;
  const reverted = await frame.evaluate((items) => {
    const out = [];
    for (const it of items) {
      const el = document.querySelector(it.selector);
      if (!el) continue;
      if (String(el.value) !== it.value) {
        out.push({ key: it.key, selector: it.selector, want: it.value, got: String(el.value) });
      }
    }
    return out;
  }, intended);
  if (reverted.length === 0) return;
  for (const r of reverted) {
    audit({ action: "field_write", field: r.selector, value: r.want, ok: true });
  }
  await frame.evaluate((items) => {
    for (const it of items) {
      const el = document.querySelector(it.selector);
      if (!el) continue;
      el.value = it.want;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, reverted.map((r) => ({ selector: r.selector, want: r.want })));
  const stillWrong = await frame.evaluate((items) => {
    const out = [];
    for (const it of items) {
      const el = document.querySelector(it.selector);
      if (el && String(el.value) !== it.want) out.push(`${it.key} (wanted '${it.want}', has '${el.value}')`);
    }
    return out;
  }, reverted);
  if (stillWrong.length > 0) {
    throw new Error(
      `FIELD_REVERTED: the form undid ${stillWrong.length} value(s) and would not keep them after being set again: ${stillWrong.join(", ")}. Submitting would file a document that does not hold what was asked for.`
    );
  }
}
async function verifySelectsHeld(frame, wanted) {
  const items = wanted.filter(([, v]) => v != null && v !== "").map(([name, v]) => ({ name, value: String(v) }));
  if (items.length === 0) return;
  const bad = await frame.evaluate(
    (items2) => {
      const out = [];
      for (const it of items2) {
        const el = document.querySelector(`select[name="${it.name}"]`);
        if (!el) continue;
        const hidden = el.offsetParent === null;
        if (el.value !== it.value || hidden) out.push({ name: it.name, want: it.value, got: el.value, hidden });
      }
      return out;
    },
    items
  );
  if (bad.length === 0) return;
  for (const b of bad) audit({ action: "refusal", field: b.name, code: b.hidden ? "SELECT_HIDDEN_BY_FORM" : "SELECT_REVERTED", ok: false });
  throw new Error(
    "SELECT_NOT_HELD: " + bad.map((b) => b.hidden ? `${b.name} is hidden by the form (value '${b.got}' would not appear on the document)` : `${b.name} wanted '${b.want}', form has '${b.got}'`).join("; ")
  );
}
async function genericFillForm(frame, fieldSchema, userData, hooks, opts) {
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "pre_fill") await hook.fn(frame, null, userData);
    }
  }
  const intended = [];
  for (const [fieldKey, schema] of Object.entries(fieldSchema)) {
    if (!schema.dom_name) continue;
    const value = userData[fieldKey];
    if (value === void 0 || value === null || value === "") continue;
    const strValue = String(value);
    const domName = schema.dom_name;
    const fieldType = schema.type;
    if (schema.dom_selectors) {
      for (const sel of schema.dom_selectors) {
        if (fieldType === "select") {
          await setSelectValue(frame, sel, strValue);
        } else {
          await setFieldValue(frame, sel, strValue);
        }
      }
      continue;
    }
    const widgetType = schema.widget_type || fieldType;
    if (widgetType === "file_upload") {
      const pathsKey = schema.file_paths_key || fieldKey;
      const rawPaths = userData[pathsKey] ?? value;
      const paths = Array.isArray(rawPaths) ? rawPaths : [String(rawPaths)];
      const validPaths = paths.filter(Boolean);
      if (validPaths.length > 0) {
        const { attachFiles: attachFiles2 } = await Promise.resolve().then(() => (init_attachment(), attachment_exports));
        await attachFiles2(frame, validPaths);
      }
      if (schema.post_actions) {
        await executePostActions(frame, schema.post_actions);
      }
      continue;
    }
    if (widgetType === "account_lookup") {
      if (opts?.page && opts?.baseUrl && opts?.budgetCode) {
        const { fetchAccountCodes: fetchAccountCodes2, setAccountCodeOnRow: setAccountCodeOnRow2 } = await Promise.resolve().then(() => (init_account(), account_exports));
        const codes = await fetchAccountCodes2(opts.page, {
          baseUrl: opts.baseUrl,
          budgetType: opts.budgetType || "02",
          budgetCode: opts.budgetCode,
          approveType: schema.account_approve_type || opts.approveType || "AppFrm-021"
        });
        const strVal = String(value);
        const match = codes.find((c) => c.code === strVal) || codes.find((c) => c.label.toLowerCase().includes(strVal.toLowerCase()));
        if (match) {
          const rowIdx = schema.account_row_idx ?? 1;
          await setAccountCodeOnRow2(frame, rowIdx, match);
        }
      }
      if (schema.post_actions) {
        await executePostActions(frame, schema.post_actions);
      }
      continue;
    }
    if (fieldType === "select") {
      const selector = schema.dom_selector || `select[name="${domName}"]`;
      if (schema.required) {
        await setRequiredSelect(frame, selector, strValue, (domName || fieldKey).replace(/\[\]/g, ""));
      } else {
        await setSelectValue(frame, selector, strValue);
      }
    } else if (fieldType === "radio") {
      continue;
    } else if (fieldType === "array" || fieldType === "table") {
      continue;
    } else if (fieldType === "hidden") {
      const selector = schema.dom_selector || `input[name="${domName}"]`;
      await setFieldValue(frame, selector, strValue);
    } else {
      const selector = schema.dom_selector || `input[name="${domName}"], textarea[name="${domName}"]`;
      if (schema.required) {
        await setRequiredField(frame, selector, strValue, (domName || fieldKey).replace(/\[\]/g, ""));
      } else {
        await setFieldValue(frame, selector, strValue);
      }
      intended.push({ selector, value: strValue, key: fieldKey });
    }
  }
  await verifyIntendedValues(frame, intended);
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "post_fill") await hook.fn(frame, null, userData);
    }
  }
  if (hooks) {
    for (const hook of hooks) {
      if (hook.trigger === "evaluate") await hook.fn(frame, null, userData);
    }
  }
}
function loadTemplateFieldSchema(formType) {
  const registry = FORM_REGISTRY[formType];
  if (!registry) return null;
  for (const projectRoot of [path4.resolve(__dirname, "..", ".."), path4.resolve(__dirname, "..", "..", "..")]) {
    const templatePath = path4.join(projectRoot, "form_templates", registry.templateFile);
    try {
      const raw = fs7.readFileSync(templatePath, "utf-8");
      const template = JSON.parse(raw);
      return template.field_schema || null;
    } catch {
      continue;
    }
  }
  return null;
}
function loadPublicRulebook(formType) {
  const registry = FORM_REGISTRY[formType];
  if (!registry) return null;
  for (const projectRoot of [path4.resolve(__dirname, "..", ".."), path4.resolve(__dirname, "..", "..", "..")]) {
    const rulesPath = path4.join(projectRoot, "rules", "public", `${registry.appFrmCode}.json`);
    try {
      return JSON.parse(fs7.readFileSync(rulesPath, "utf-8"));
    } catch {
      continue;
    }
  }
  return null;
}
function loadJsonIfPresent(p) {
  try {
    return JSON.parse(fs7.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}
function loadFieldRulesOptions(formType) {
  const home = process.env.IPK_HOME_DIR ?? process.env.HOME ?? "";
  const profile = loadProfile() ?? void 0;
  const registry = FORM_REGISTRY[formType];
  const privatePack = home && registry ? loadJsonIfPresent(path4.join(home, ".config", "ipk-browser-mcp", "knowledge", "rules", `${registry.appFrmCode}.json`)) : void 0;
  return { profile, privatePack };
}
function mergeRulebook(pub, pack) {
  if (!pack) return pub;
  return { ...pub, fields: { ...pub.fields, ...pack.fields }, conditional: [...pub.conditional ?? [], ...pack.conditional ?? []] };
}
async function checkFieldRulesAgainstForm(frame, formType) {
  const pub = loadPublicRulebook(formType);
  if (!pub) return null;
  const { profile, privatePack } = loadFieldRulesOptions(formType);
  const book = mergeRulebook(pub, privatePack);
  const serialized = await serializeFormFields(frame, Object.keys(book.fields)) ?? {};
  if (Object.keys(serialized).length === 0) {
    audit({ action: "refusal", code: "FIELD_RULES_UNAVAILABLE", ok: false });
    return {
      code: "FORM_RULE_VIOLATION",
      message: `${book.form}: the form's own fields could not be read (empty or unreadable serialization) - refusing to save unchecked.`,
      violations: []
    };
  }
  let result;
  try {
    const env = {
      IPK_GROUP_LEADER: process.env.IPK_GROUP_LEADER,
      IPK_SUBSTITUTE_NAME: process.env.IPK_SUBSTITUTE_NAME,
      IPK_EMERGENCY_ADDRESS: process.env.IPK_EMERGENCY_ADDRESS,
      IPK_EMERGENCY_TELEPHONE: process.env.IPK_EMERGENCY_TELEPHONE
    };
    result = checkFieldRules(book, serialized, { profile, env, unknownFields: "warn" });
  } catch (e) {
    if (e instanceof FieldRulesUnavailable) {
      audit({ action: "refusal", code: "FIELD_RULES_UNAVAILABLE", ok: false });
      return { code: "FORM_RULE_VIOLATION", message: e.message, violations: [] };
    }
    throw e;
  }
  if (result.blocks.length === 0) return null;
  for (const v of result.blocks) audit({ action: "refusal", code: "FIELD_RULE_VIOLATION", field: v.field, ok: false });
  return { code: "FORM_RULE_VIOLATION", message: result.blocks.map((v) => `[${v.field}] ${v.message}`).join("\n"), violations: result.blocks };
}
async function checkFieldRulesRaw(frame, formType) {
  const pub = loadPublicRulebook(formType);
  if (!pub) return null;
  const book = mergeRulebook(pub, loadFieldRulesOptions(formType).privatePack);
  const knownNames = Object.keys(book.fields);
  const serialized = await serializeFormFields(frame, knownNames) ?? {};
  if (Object.keys(serialized).length === 0) {
    return { blocks: [{ field: "(form)", scope: "form", message: "form fields unreadable" }], warnings: [] };
  }
  const { profile } = loadFieldRulesOptions(formType);
  const env = {
    IPK_GROUP_LEADER: process.env.IPK_GROUP_LEADER,
    IPK_SUBSTITUTE_NAME: process.env.IPK_SUBSTITUTE_NAME,
    IPK_EMERGENCY_ADDRESS: process.env.IPK_EMERGENCY_ADDRESS,
    IPK_EMERGENCY_TELEPHONE: process.env.IPK_EMERGENCY_TELEPHONE
  };
  try {
    return checkFieldRules(book, serialized, { profile, env, unknownFields: "warn" });
  } catch (e) {
    if (e instanceof FieldRulesUnavailable) {
      return { blocks: [{ field: "(form)", scope: "form", message: e.message }], warnings: [] };
    }
    throw e;
  }
}
async function buildDryRunPreview(page, frame, config, formType) {
  const pub = loadPublicRulebook(formType);
  const book = pub ? mergeRulebook(pub, loadFieldRulesOptions(formType).privatePack) : null;
  const knownNames = book ? Object.keys(book.fields) : [];
  const serialized = await serializeFormFields(frame, knownNames) ?? {};
  const fieldRuleResult = await checkFieldRulesRaw(frame, formType) ?? { blocks: [], warnings: [] };
  let screenshot;
  try {
    fs7.mkdirSync(config.screenshotDir, { recursive: true, mode: 448 });
    const filename = `dry-run-${formType}-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.png`;
    const filepath = path4.join(config.screenshotDir, filename);
    await page.screenshot({ path: filepath, fullPage: true });
    screenshot = filepath;
    const ttlMs = config.screenshotTtlMinutes * 60 * 1e3;
    setTimeout(() => {
      try {
        if (fs7.existsSync(filepath)) fs7.unlinkSync(filepath);
      } catch {
      }
    }, ttlMs);
  } catch {
  }
  return {
    dry_run: true,
    form: formType,
    url: typeof frame.url === "function" ? frame.url() : "",
    fields: serialized,
    field_rule_result: fieldRuleResult,
    warnings: fieldRuleResult.warnings.map((w) => w.message),
    screenshot,
    message: `dry_run: ${formType} filled and checked, nothing saved. ${fieldRuleResult.blocks.length} field-rule block(s), ${fieldRuleResult.warnings.length} warning(s).`
  };
}
async function attachFile(frame, filePath, explicitTarget) {
  const err = validateAttachmentPath(filePath);
  if (err) {
    audit({ action: "refusal", code: "INVALID_ATTACHMENT", validated: false, ok: false });
    throw new Error(`INVALID_ATTACHMENT: ${err}`);
  }
  const target = explicitTarget ?? await frame.evaluate(() => {
    if (document.querySelector("input.travel_file")) return "input.travel_file";
    const cnt = document.querySelector('select[name="file_attach_cnt"]');
    if (cnt && Number(cnt.value) < 1) {
      cnt.value = "1";
      cnt.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return 'input[name="doc_attach_file[]"]';
  });
  await frame.waitForSelector(target, { state: "attached", timeout: 5e3 }).catch(() => null);
  const fileInput = frame.locator(target).first();
  await fileInput.setInputFiles(filePath);
  const landed = await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    return !!(el && el.files && el.files.length > 0);
  }, target);
  if (!landed) {
    audit({ action: "refusal", code: "ATTACHMENT_NOT_ACCEPTED", validated: true, ok: false });
    throw new Error(
      `ATTACHMENT_NOT_ACCEPTED: the file did not attach to '${target}'. The upload slot may not have been created - check file_attach_cnt on this form.`
    );
  }
  audit({ action: "upload", validated: true, ok: true });
}
async function selectExistingOption(frame, selector, value, fieldName, timeoutMs = 5e3) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: "no_element", options: [] };
  for (; ; ) {
    last = await frame.evaluate(
      (args) => {
        const el = document.querySelector(args.selector);
        if (!el) return { status: "no_element", options: [] };
        const enabled2 = Array.from(el.options).filter((o) => !o.disabled);
        const options = enabled2.map((o) => o.value);
        if (!options.includes(args.value)) {
          return { status: "no_option", options: Array.from(el.options).map((o) => o.value) };
        }
        el.value = args.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        if (el.value !== args.value) return { status: "reverted", options };
        const label = el.options[el.selectedIndex]?.text?.trim() ?? "";
        return { status: "ok", options, label, hidden: el.offsetParent === null };
      },
      { selector, value }
    );
    if (last.status === "ok") {
      audit({ action: "option_select", field: fieldName, value, label: last.label, fromOfferedOptions: true, hidden: last.hidden, ok: true });
      return;
    }
    if (last.status === "reverted") {
      audit({ action: "refusal", field: fieldName, code: "OPTION_REJECTED", ok: false });
      throw new Error(
        `OPTION_REJECTED: the form reset '${fieldName}' after selecting '${value}'. It is probably not valid together with the other values on this form.`
      );
    }
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (last.status === "no_element") {
    audit({ action: "refusal", field: fieldName, code: "FIELD_NOT_FOUND", ok: false });
    throw new Error(`FIELD_NOT_FOUND: Required field '${fieldName}' not found (selector: ${selector})`);
  }
  audit({ action: "refusal", field: fieldName, code: "INVALID_OPTION", fromOfferedOptions: false, ok: false });
  throw new Error(
    `INVALID_OPTION: '${value}' is not an option the form offers for '${fieldName}' (waited ${timeoutMs}ms in case the form populates it). Allowed: ${last.options.join(", ") || "(none)"}`
  );
}
async function selectRadio(frame, name, value) {
  const outcome = await frame.evaluate(
    (args) => {
      const all = Array.from(
        document.querySelectorAll(`input[type="radio"][name="${args.name}"]`)
      );
      if (all.length === 0) return { status: "no_element", offered: [] };
      const offered = all.map((r) => r.value);
      const match = all.find((r) => r.value === args.value);
      if (!match) return { status: "no_option", offered };
      match.click();
      if (!match.checked) {
        match.checked = true;
        match.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { status: match.checked ? "ok" : "reverted", offered };
    },
    { name, value }
  );
  if (outcome.status === "ok") {
    audit({ action: "option_select", field: name, value, fromOfferedOptions: true, ok: true });
    return;
  }
  audit({ action: "refusal", field: name, code: `RADIO_${outcome.status.toUpperCase()}`, ok: false });
  if (outcome.status === "no_element") {
    throw new Error(`FIELD_NOT_FOUND: no radio group named '${name}' on this form`);
  }
  if (outcome.status === "reverted") {
    throw new Error(`OPTION_REJECTED: the form cleared '${name}' after selecting '${value}'.`);
  }
  throw new Error(
    `INVALID_OPTION: '${value}' is not one of the '${name}' choices. Allowed: ${outcome.offered.join(", ")}`
  );
}
async function assertTotalMatchesItems(frame) {
  const check = await frame.evaluate(() => {
    const unparsable = [];
    const num = (raw, label) => {
      const text = String(raw ?? "").trim();
      if (text === "") return 0;
      const cleaned = text.replace(/[,\s\u00a0]/g, "");
      if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
        unparsable.push(`${label}='${text}'`);
        return 0;
      }
      return Number(cleaned);
    };
    const totalEl = document.getElementsByName("total_amt")[0];
    if (!totalEl) return null;
    const items = Array.from(
      document.querySelectorAll('input[name="item_amount[]"]')
    );
    const filled = items.filter((el) => String(el.value ?? "").trim() !== "");
    if (filled.length === 0) return null;
    const sum = filled.reduce((acc, el, i) => acc + num(el.value, `item_amount[${i}]`), 0);
    const vats = Array.from(
      document.querySelectorAll('input[name="item_amount_vat[]"]')
    );
    const vatSum = vats.reduce((acc, el, i) => acc + num(el.value, `item_amount_vat[${i}]`), 0);
    return { total: num(totalEl.value, "total_amt"), sum, vatSum, unparsable };
  });
  if (!check) return;
  if (check.unparsable.length > 0) {
    throw new Error(
      `TOTAL_UNVERIFIABLE: cannot read amount(s) ${check.unparsable.join(", ")} as numbers, so the total cannot be checked against the line items.`
    );
  }
  const withVat = check.sum + check.vatSum;
  const ok = check.vatSum > 0 ? check.total === withVat : check.total === check.sum;
  if (!ok) {
    throw new Error(
      `TOTAL_MISMATCH: total_amt=${check.total} but line items sum to ${check.sum}` + (check.vatSum > 0 ? ` (+VAT ${check.vatSum} = ${withVat})` : "") + `. Refusing to submit a document that disagrees with itself.`
    );
  }
}
var ipkSubmitFormSchema = {
  form_type: external_exports.enum([
    "leave",
    "expense",
    "working",
    "travel",
    "travel_request",
    "budget_transfer",
    // Wave 2 form types
    "travel_settlement",
    "leave_return",
    "card_expense",
    "card_expense_rd",
    "seminar",
    "overseas_travel"
  ]).describe("Form type to submit"),
  // card_expense_rd (AppFrm-021) — R&D ER constructed from a corporate card receipt.
  // Required: trseq + appr_no (from corporation_card_list.php Make ER link). Most other
  // fields are auto-filled by the form via the mker=Y URL pattern.
  trseq: external_exports.string().optional().describe("Card receipt transaction sequence (e.g. '26040417102'). Required for card_expense_rd."),
  appr_no: external_exports.string().optional().describe("Card approval number (e.g. '19984403' or 'i5773800' for overseas). Required for card_expense_rd."),
  item_name: external_exports.string().optional().describe("Item name for card_expense_rd row (English). e.g. 'Google Cloud Gemini API service'."),
  seller_en: external_exports.string().optional().describe("English vendor name for card_expense_rd row. e.g. 'Google Cloud Korea LLC'."),
  account_code_label: external_exports.string().optional().describe("Substring/regex to auto-pick account code from Sel_account popup options (e.g. 'IT Software'). If account_code is also given, account_code wins."),
  attachment_paths: external_exports.array(external_exports.string()).optional().describe("Multiple attachment file paths for card_expense_rd. Each file is uploaded to a separate slot. For accounts with a kind requirement (e.g. 410306), use attachments[] instead - this legacy param is refused there without a kind."),
  attachments: external_exports.array(external_exports.object({
    path: external_exports.string(),
    kind: external_exports.enum(ATTACHMENT_KINDS),
    quotes: external_exports.array(external_exports.string()).optional().describe("Text the agent itself read from this file, quoted verbatim - not guessed from the filename. Required to clear program/fee_table/society_receipt attestation on accounts that need it (e.g. 410306).")
  })).optional().describe("card_expense_rd attachments with a kind label each (card_slip, society_receipt, invoice, permission, fee_table, program, usage, receipt, other). One file = one kind; a duplicate kind is refused. Replaces attachment_path(s) for accounts with a kind requirement."),
  attestation_exception: external_exports.array(external_exports.object({
    kind: external_exports.enum(ATTACHMENT_KINDS),
    date: external_exports.string().optional().describe("YYYY-MM-DD, for a program date that cannot be quoted (e.g. a weekday-only schedule grid)."),
    reason: external_exports.string(),
    person_confirmed: external_exports.literal(true)
  })).optional().describe("Exempts one attestation gap (e.g. a fee table with no single total line) instead of blocking - requires person_confirmed:true. Recorded in the audit and flagged in the result; never a silent pass."),
  // card_expense_rd event-block fields (account 410306 and others that open the Event
  // Name/Organizer/Date/Attendee block) - DOM names from form_rules/AppFrm-021.json and
  // submit_ai4sci_registration_er.py:41-58 (301306, 2026-10-07 session).
  event_name: external_exports.string().optional().describe("card_expense_rd event block: org_name (e.g. conference/event name). English only."),
  event_type: external_exports.string().optional().describe("card_expense_rd event block: dmex_se_cd code (e.g. '01')."),
  organizer: external_exports.string().optional().describe("card_expense_rd event block: organizer_nm. English only."),
  event_start: external_exports.string().optional().describe("card_expense_rd event block: edu_start_day (YYYY-MM-DD)."),
  event_end: external_exports.string().optional().describe("card_expense_rd event block: edu_end_day (YYYY-MM-DD)."),
  notes: external_exports.string().optional().describe("card_expense_rd: written to the form's 'notes' field (alongside p_reason/reason, which the form also calls Notes in some accounts)."),
  allow_card_er_save: external_exports.boolean().optional().describe(`card_expense_rd only: refused (CARD_ER_SAVE_REFUSED) unless ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json holds a one-time authorization for THIS transaction - { "<appr_no>": { "trseq": "<trseq>", "authorized_at": "<ISO>", "note": "..." } }, matched on both appr_no and trseq, written by a person outside the tool. The tool consumes the entry before clicking (one entry = one attempt), then runs the form's own [Draft] link (mode1='draft' + Check_Form_Request + budget popup submit_form()) and reads document_view back: SUBMITTED_NOT_DRAFT / DRAFT_SAVED / DRAFT_NOT_CONFIRMED. The server may still file it for approval (doc 302098, 2026-10-23); the tool never retries or repossesses. Without an authorization: dry_run=true, review the screenshot, press [Draft] yourself.`),
  draft_only: external_exports.boolean().default(true).describe("Save as draft (true) or submit for approval (false). Defaults to true for safety. For card_expense_rd, draft_only=true is a no-save preview unless allow_card_er_save has a one-time authorization (see allow_card_er_save); draft_only=false is refused outright (CARD_ER_NO_SUBMIT)."),
  dry_run: external_exports.boolean().default(false).optional().describe(
    "Preview only, for every wired form type - safe, never saves/drafts/submits anything. Runs the full pipeline (param validation, org-policy, navigation, filling the form, field-rules checked against the live DOM) and stops before the save click. Returns { dry_run, form, url, fields (serialized DOM), field_rule_result (blocks/warnings - never causes a refusal under dry_run), warnings, screenshot }. For the domestic travel report, dry_run also skips the REPORT_ALREADY_EXISTS refusal and reports existing_report_lengths instead, since nothing is written either way."
  ),
  confirm_submit: external_exports.boolean().default(false).describe("Must be true to actually submit for approval. Ignored when draft_only=true."),
  // Leave fields
  leave_type: external_exports.string().optional().describe("Leave type: annual, compensatory, sick, paternity, etc."),
  start_date: external_exports.string().optional().describe("Start date (YYYY-MM-DD)"),
  end_date: external_exports.string().optional().describe("End date (YYYY-MM-DD)"),
  start_time: external_exports.string().optional().describe("Start hour for hourly leave (e.g. '14')"),
  // Undeclared parameters are dropped before the handler sees them, so a travel request's
  // times were silently never written and the form answered "Check travel time."
  start_tm: external_exports.string().optional().describe("travel_request departure time, HH:MM on the half hour (e.g. '08:00')"),
  bound_code: external_exports.string().optional().describe("travel_request: '19' within metro (form hides province/city and forces working_code 197) or '20' out of metro (province_code, city_code, travel_type_code required; working_code hidden). Seoul sampling trips in this department are filed as '20' + Seoul/Seoul."),
  purpose_type: external_exports.string().optional().describe("travel_request type of business travel: '1' conference, '2' presentation, '3' technical meeting, '4' training, '5' simple visit"),
  matrials: external_exports.string().optional().describe("travel_request: 'Y' if research materials leave the institute (then a Public Disclosure Approval file is required), 'N' otherwise. The form defaults to 'Y'."),
  working_code: external_exports.string().optional().describe("travel_request: '197' within 4 hours, '198' more than 4 hours"),
  province_code: external_exports.string().optional().describe("travel_request province, e.g. '02' Seoul, '03' Gyeonggi-do"),
  city_code: external_exports.string().optional().describe("travel_request city; the form fills this from province_code (Seoul is '192')"),
  travel_type_code: external_exports.string().optional().describe("travel_request transport: '01' institute vehicle, '02' own vehicle, '03' other public transport"),
  end_tm: external_exports.string().optional().describe("travel_request return time, HH:MM on the half hour (e.g. '16:00')"),
  attachment_slot: external_exports.enum(["transport", "accommodation", "boarding", "etc", "verification", "poster", "general"]).optional().describe("travel_request / travel_settlement / overseas_travel: which attachment row the file goes in. Required when attachment_path is given on these forms. Approval emails for sampling trips go in 'verification'; receipts in 'transport'/'accommodation'; 'general' is the settlements' plain File Attachment row."),
  precedent: external_exports.boolean().default(true).describe("travel_request: read the department's recent approved requests of this form before drafting and report where the draft departs from them. Never fills a value in; set false to skip the lookup."),
  budget_code_confirmed: external_exports.boolean().optional().describe("travel_request: pass true to file against a budget_code that differs from the writer's recent approved requests (the tool refuses otherwise, since an offered code can still be an empty pot)."),
  precedent_keyword: external_exports.string().optional().describe("travel_request: keyword to pick precedents by (e.g. 'RAPID'). Defaults to no keyword, i.e. the writer's most recent requests."),
  meals_served: external_exports.string().optional().describe("travel_request, required with bound_code '20': 'N' if no meals are provided on the trip, otherwise the number of meals served (1-30). The form refuses to save without an answer."),
  credit_card_no: external_exports.string().optional().describe("travel_request: institute corporate card, 16 digits (e.g. '1234-5678-9012-3456'). Only the traveler's own card, as shown on their previous approved requests."),
  end_time: external_exports.string().optional().describe("End hour for hourly leave (e.g. '17')"),
  purpose: external_exports.string().optional().describe("Purpose/reason. English only - Korean text is refused before the form is touched."),
  destination: external_exports.string().optional().describe("Destination. English only - Korean text is refused before the form is touched."),
  substitute_name: external_exports.string().optional().describe("Substitute person name"),
  // Expense fields
  amount: external_exports.number().optional().describe("Total amount in KRW"),
  participants: external_exports.string().optional().describe("Participants for meal expense. English only - Korean text is refused before the form is touched."),
  venue: external_exports.string().optional().describe("Venue for expense. English only - Korean text is refused before the form is touched."),
  budget_code: external_exports.string().optional().describe("Budget code (required for expense/working/travel_request forms). Use the active fiscal year code, e.g. NN2612-0001. For card_expense_rd, selects the budget pot in the mker form's own select (it otherwise defaults to the first option); refused if not among the options offered."),
  attachment_path: external_exports.string().optional().describe("Path to attachment file"),
  // Working fields (AppFrm-074, weekend/holiday overtime)
  work_date: external_exports.string().optional().describe("expense: date of purchase (YYYY-MM-DD)"),
  rows: external_exports.array(external_exports.object({
    date: external_exports.string().describe("YYYY-MM-DD"),
    hours: external_exports.number().describe("1-12, whole hours")
  })).optional().describe("working: one row per weekend/holiday work date, {date, hours}. hours must be 1-12 (the form's own select only offers whole hours in that range); total hours per ISO week must not exceed 12. A weekday date warns (no public-holiday calendar to tell a holiday weekday from an ordinary one) but is not refused."),
  reason: external_exports.string().optional().describe("Reason for work/travel. English only - Korean text is refused before the form is touched. working: min 20 chars."),
  details: external_exports.string().optional().describe("Details. English only - Korean text is refused before the form is touched."),
  budget_type: external_exports.string().optional().describe("expense/travel_request budget type: 01=General, 02=R&D"),
  // Travel fields (domestic report, written onto the approved AppFrm-023 request)
  title: external_exports.string().optional().describe("overseas report (AppFrm-076) subject. Not used by the domestic report, which has no subject field."),
  organization: external_exports.string().optional().describe("Organization/institution"),
  attendees: external_exports.string().optional().describe("Attendees"),
  schedule: external_exports.string().optional().describe("Schedule details"),
  request_doc_id: external_exports.string().optional().describe("travel: doc_id of the already-approved travel request this reports on. Auto-looked-up from this person's own approved AppFrm-023/AppFrm-026 documents (optionally narrowed by keyword) when omitted and exactly one match exists; refused (not guessed) when 0 or >1 match."),
  request_keyword: external_exports.string().optional().describe("travel: keyword to narrow the request_doc_id auto-lookup (e.g. 'RAPID'), passed to document_list.php's own search."),
  report_kind: external_exports.enum(["domestic", "overseas"]).optional().describe("travel: 'domestic' (default) writes onto the approved AppFrm-023 request at travel_report_write.php. 'overseas' uses the standalone AppFrm-076 form instead. Auto-detected as 'overseas' when the resolved request is AppFrm-026."),
  persons_met: external_exports.string().optional().describe("travel (domestic report): who was met / contact info for this trip - the counterparty, never this person's own name. Left blank (with a warning) if omitted."),
  overwrite_report: external_exports.boolean().optional().describe("travel (domestic report): the linked request already has a report written (its content fields are non-empty) - pass true to replace it. Refused otherwise (REPORT_ALREADY_EXISTS) rather than silently overwriting."),
  // Budget transfer fields
  from_budget_code: external_exports.string().optional().describe("Source budget code to transfer FROM"),
  to_budget_code: external_exports.string().optional().describe("Destination budget code to transfer TO"),
  transfer_amount: external_exports.number().optional().describe("Amount to transfer in KRW"),
  transfer_type: external_exports.enum(["rnd", "general"]).default("rnd").describe("Budget transfer type: rnd (R&D, AppFrm-039) or general (AppFrm-053)"),
  // Card expense fields (AppFrm-020)
  item_date: external_exports.string().optional().describe("Date of purchase (YYYY-MM-DD)"),
  item_account_code: external_exports.string().optional().describe("Account code: 420421=Team activities, 420420=External meeting, 420374=Commission, 420375=Registration"),
  item_description: external_exports.string().optional().describe("Expense description (e.g. 'Team activities'). English only - Korean text is refused before the form is touched."),
  item_vendor: external_exports.string().optional().describe("Vendor/store name. English only - Korean text is refused before the form is touched."),
  item_control_no: external_exports.string().optional().describe("Card receipt control number"),
  purpose_minutes: external_exports.string().optional().describe("Meeting purpose and minutes"),
  meeting_begin: external_exports.string().optional().describe("card_expense_rd meeting accounts (e.g. Team Activities 412107): meeting start, 'YYYY-MM-DD HH:MM'. Required with every meeting account."),
  meeting_end: external_exports.string().optional().describe("card_expense_rd meeting accounts (e.g. Team Activities 412107): meeting end, 'YYYY-MM-DD HH:MM'. Required with every meeting account."),
  overtime_begin: external_exports.string().optional().describe("card_expense_rd Overtime Meals account (412103): overtime start, 'YYYY-MM-DD HH:MM'. Required with the 412103 account."),
  overtime_end: external_exports.string().optional().describe("card_expense_rd Overtime Meals account (412103): overtime end, 'YYYY-MM-DD HH:MM'. Required with the 412103 account."),
  overtime_purpose: external_exports.string().optional().describe("card_expense_rd Overtime Meals account (412103): purpose of the overtime (English). Required with the 412103 account."),
  // Travel settlement fields (AppFrm-054)
  province: external_exports.string().optional().describe("Province select value for AJAX cascade"),
  city: external_exports.string().optional().describe("City select value for AJAX cascade"),
  transport_mode: external_exports.string().optional().describe("Transport mode: 'Other Public Transporation', 'Own Vehicle - Gasoline', 'Own Vehicle - Diesel'"),
  budget_control_no: external_exports.string().optional().describe("Budget control number (BC-XXXX-XXXX)"),
  purpose_category: external_exports.string().optional().describe("Purpose category for travel settlement"),
  daily_expense: external_exports.number().optional().describe("Daily expense amount in KRW"),
  transport_fee: external_exports.number().optional().describe("Transport fee in KRW"),
  accommodation: external_exports.number().optional().describe("Accommodation fee in KRW"),
  food_expense: external_exports.number().optional().describe("Food expense in KRW"),
  approved_doc_ref: external_exports.string().optional().describe("Document number of the approved travel request"),
  oil_price: external_exports.number().optional().describe("Oil price per liter (own vehicle)"),
  distance_km: external_exports.number().optional().describe("Distance in km (own vehicle)"),
  toll_fee: external_exports.number().optional().describe("Toll fee in KRW (own vehicle)"),
  // Leave return fields (AppFrm-028)
  original_leave_doc: external_exports.string().optional().describe("Document number of original leave (e.g. ARL-260121-02)"),
  return_days: external_exports.number().optional().describe("Number of days to return"),
  return_hours: external_exports.number().optional().describe("Number of hours to return"),
  description: external_exports.string().optional().describe("Reason for leave return. English only - Korean text is refused before the form is touched."),
  // Seminar fields (AppFrm-043)
  disclosure_purpose: external_exports.string().optional().describe("Why the material is being disclosed"),
  disclosure_date: external_exports.string().optional().describe("Date of seminar/event (YYYY-MM-DD)"),
  material_description: external_exports.string().optional().describe("Material filename and size"),
  conference_or_journal: external_exports.string().optional().describe("Name of conference or journal"),
  patent_filed: external_exports.enum(["Y", "N", ""]).optional().describe("Q1: Patent filed?"),
  patent_planned: external_exports.enum(["Y", "N", ""]).optional().describe("Q2: Patent planned within a year?"),
  material_published: external_exports.enum(["Y", "N", ""]).optional().describe("Q3: Material published?"),
  collaborator_approval: external_exports.enum(["Y", ""]).optional().describe("Q4: Collaborator approval obtained?"),
  contains_confidential: external_exports.enum(["N", ""]).optional().describe("Q5: Contains IPK confidential info?"),
  // Overseas travel fields (AppFrm-026)
  country: external_exports.string().optional().describe("Destination country and city"),
  conference_name: external_exports.string().optional().describe("Conference or organization name"),
  travel_start: external_exports.string().optional().describe("Departure date (YYYY-MM-DD)"),
  travel_end: external_exports.string().optional().describe("Return date (YYYY-MM-DD)"),
  payment_date: external_exports.string().optional().describe("Settlement payment date (YYYY-MM-DD)"),
  schedule_rows: external_exports.array(external_exports.object({
    from: external_exports.string(),
    to: external_exports.string(),
    schedule: external_exports.string(),
    transportation: external_exports.string()
  })).optional().describe("Daily itinerary rows"),
  daily_expense_budget: external_exports.number().optional().describe("Daily allowance budget (KRW)"),
  daily_expense_cash: external_exports.number().optional().describe("Daily allowance cash amount (KRW)"),
  food_expense_budget: external_exports.number().optional().describe("Food expense budget (KRW)"),
  food_expense_cash: external_exports.number().optional().describe("Food expense cash amount (KRW)"),
  transport_fee_budget: external_exports.number().optional().describe("Transport fee budget (KRW)"),
  transport_fee_corp_card: external_exports.number().optional().describe("Transport fee paid by corp card (KRW)"),
  accommodation_budget: external_exports.number().optional().describe("Accommodation budget (KRW)"),
  accommodation_corp_card: external_exports.number().optional().describe("Accommodation paid by corp card (KRW)"),
  settle_amount: external_exports.number().optional().describe("Total settlement amount (KRW)"),
  reimbursement: external_exports.number().optional().describe("Amount to reimburse traveler (KRW)"),
  corp_card_no: external_exports.string().optional().describe("Corporate card number (XXXX-XXXX-XXXX-XXXX)")
};
var ipkSubmitFormDescription = "Submit a form in IPK groupware. All 11 form types are fully implemented: leave (\uD734\uAC00/AppFrm-073), expense (\uACBD\uBE44/AppFrm-020), working (\uD734\uC77C\uADFC\uBB34/AppFrm-074), travel (\uCD9C\uC7A5\uBCF4\uACE0/AppFrm-076), travel_request (\uCD9C\uC7A5\uC2E0\uCCAD/AppFrm-023), budget_transfer (\uC608\uC0B0\uC804\uC6A9/AppFrm-039), card_expense (\uCE74\uB4DC\uACBD\uBE44/AppFrm-020), travel_settlement (\uCD9C\uC7A5\uC815\uC0B0/AppFrm-054), leave_return (\uB300\uCCB4\uD734\uC77C\uBC18\uB0A9/AppFrm-028), seminar (\uC138\uBBF8\uB098\uACF5\uC2DC/AppFrm-043), overseas_travel (\uD574\uC678\uCD9C\uC7A5/AppFrm-026). By default saves as draft (draft_only=true); a draft is reported only after it is found in the Drafts list (SUBMITTED_NOT_DRAFT / DRAFT_NOT_CONFIRMED otherwise). card_expense_rd (AppFrm-021, mker=Y) is never submitted by this tool, and is saved only through a one-time per-transaction authorization. draft_only=true returns a no-save preview that fills and checks the form with the form's own validation; draft_only=false is refused outright (CARD_ER_NO_SUBMIT), regardless of confirm_submit/IPK_ALLOW_SUBMIT. allow_card_er_save=true runs the form's own [Draft] link only when ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json has an entry for this appr_no+trseq (consumed before the click), and reports SUBMITTED_NOT_DRAFT if the server filed it anyway (as it did with doc 302098 on 2026-10-23); otherwise CARD_ER_SAVE_REFUSED and the person presses [Draft]/[Request] themselves. dry_run=true is safe to use on any wired form type (leave, working, travel_request, travel [domestic/overseas], travel_settlement, budget_transfer, expense, card_expense, card_expense_rd): it fills and checks the form exactly as a real call would, then stops before any save/draft/submit action - never creates, modifies or overwrites a document. NO_FINAL_SUBMIT: draft_only=false is refused unless confirm_submit=true AND env IPK_ALLOW_SUBMIT=1 (and for card_expense_rd it is refused outright regardless, CARD_ER_NO_SUBMIT). Even unlocked, this tool still only saves a draft and returns a no_final_submit note with the click path - it never performs the final approval-request click itself. For budget_transfer, use transfer_type='rnd' (AppFrm-039, default) or transfer_type='general' (AppFrm-053). Required params per form_type: leave: leave_type, start_date, end_date; expense: budget_code, amount, reason; working: reason, rows ([{date, hours}], weekend/holiday overtime - AppFrm-074, hours 1-12, weekly total <=12); travel: purpose, start_date, end_date (domestic default - writes onto the approved AppFrm-023 request at travel_report_write.php; request_doc_id auto-looked-up if omitted; 0-night trips and reports with purpose/agenda/result under 100 chars are refused; pass report_kind='overseas' for the standalone AppFrm-076 form instead, which also needs title/destination); travel_request: budget_code, title, destination, start_date, end_date; budget_transfer: from_account, to_account, amount, reason; card_expense: budget_code, amount, reason; travel_settlement: budget_code, title, destination, start_date, end_date; leave_return: leave_type, start_date, end_date; seminar: title, date, location; overseas_travel: budget_code, title, destination, start_date, end_date, purpose. Error recovery: NOT_LOGGED_IN\u2192call ipk_login first; FRAME_NOT_FOUND\u2192call ipk_navigate first; CONFIRMATION_REQUIRED\u2192set draft_only=true for safe draft mode; POLICY_VIOLATION/FORM_RULE_VIOLATION\u2192read the violations list, nothing was written; SESSION_EXPIRING\u2192re-login.";
function attachmentSlotRefusal(params) {
  const v = checkAttachmentSlot(params);
  if (v.length === 0) return null;
  for (const x of v) audit({ action: "refusal", code: x.code, field: x.fields.join(","), ok: false });
  return { code: "FORM_RULE_VIOLATION", message: v.map((x) => `[${x.code}] ${x.message}`).join("\n"), violations: v };
}
var PRECEDENT_FOR = /* @__PURE__ */ new WeakMap();
var TRAVEL_REPORT_ROUTE = /* @__PURE__ */ new WeakMap();
var FORM_NAV_CONFIG = {
  travel: {
    // Resolves request_doc_id (explicit or auto-looked-up) and the domestic/overseas
    // route before any page is loaded, same reasoning as travel_request's precedent
    // lookup below: this needs the network, so it can't be the sync `validate` hook.
    beforeNavigate: async (page, params, config) => {
      let docId = params.request_doc_id ? String(params.request_doc_id) : void 0;
      let formCode = params.report_kind === "overseas" ? "AppFrm-026" : "AppFrm-023";
      if (!docId) {
        const found = await findOwnApprovedTravelRequest(page, {
          baseUrl: config.baseUrl,
          keyword: params.request_keyword || params.title || params.destination
        });
        if ("error" in found) {
          audit({ action: "refusal", code: "TRAVEL_REQUEST_NOT_FOUND", field: "request_doc_id", ok: false });
          return {
            code: "TRAVEL_REQUEST_NOT_FOUND",
            message: `${found.error}. Pass request_doc_id explicitly (the approved AppFrm-023/AppFrm-026 document this reports on).`
          };
        }
        docId = found.docId;
        if (params.report_kind !== "domestic") formCode = found.formCode;
      }
      const kind = params.report_kind === "overseas" || formCode === "AppFrm-026" ? "overseas" : "domestic";
      TRAVEL_REPORT_ROUTE.set(params, { kind, requestDocId: docId });
    },
    customUrl: (params, config) => {
      const route = TRAVEL_REPORT_ROUTE.get(params);
      const origin = new URL(config.baseUrl).origin;
      if (route?.kind === "domestic") {
        return `${origin}/Document/travel_report_write.php?doc_id=${encodeURIComponent(route.requestDocId)}&approve_type=AppFrm-023&pop=Y`;
      }
      return `${origin}/Document/document_write.php?approve_type=AppFrm-076`;
    },
    waitSelector: 'input[name="report_date"], input[name="subject"]',
    waitMs: 2e3
  },
  travel_request: {
    // Combinations the form itself would undo (src/forms/travel-request.ts), refused
    // before any page is loaded so the caller learns all of them at once.
    validate: (params) => {
      const v = checkTravelRequestParams(params);
      if (v.length === 0) return null;
      for (const x of v) audit({ action: "refusal", code: x.code, field: x.fields.join(","), ok: false });
      return { code: "FORM_RULE_VIOLATION", message: v.map((x) => `[${x.code}] ${x.message}`).join("\n"), violations: v };
    },
    // Precedent is read before the form is opened: the lookup navigates the page, and
    // the form would be lost. It is advisory only (see src/precedent/fetch.ts).
    beforeNavigate: async (page, params, config, sessionManager) => {
      if (params.precedent === false) return;
      const set = await fetchTravelRequestPrecedents(page, {
        baseUrl: config.baseUrl,
        formCode: "AppFrm-023",
        keyword: params.precedent_keyword,
        writer: sessionManager.getUserInfo()?.name,
        n: 3
      });
      PRECEDENT_FOR.set(params, set);
      audit({ action: "precedent", field: "travel_request", value: String(set.docs.length), ok: !set.error });
      const practice = set.profile.stable.budget_code;
      if (practice && params.budget_code && practice.value !== String(params.budget_code) && params.budget_code_confirmed !== true) {
        audit({ action: "refusal", code: "BUDGET_DIFFERS_FROM_PRACTICE", field: "budget_code", value: String(params.budget_code), label: practice.value, ok: false });
        return {
          code: "BUDGET_DIFFERS_FROM_PRACTICE",
          message: `budget_code '${params.budget_code}' differs from the code on all ${practice.n} recent approved requests (${set.docs.map((d) => d.docNo).join(", ")}): '${practice.value}'. A pot can be empty while its code is still offered. Confirm which pot has balance, then resubmit with budget_code_confirmed: true, or use '${practice.value}'.`
        };
      }
    }
  },
  travel_settlement: { validate: (params) => attachmentSlotRefusal(params) },
  overseas_travel: { validate: (params) => attachmentSlotRefusal(params) },
  card_expense_rd: {
    validate: (params) => !params.trseq || !params.appr_no ? "card_expense_rd requires trseq and appr_no (from corporation_card_list.php Make ER link)." : null,
    customUrl: (params, config) => `${config.baseUrl}/Document/document_write.php?approve_type=AppFrm-021&mker=Y&trseq=${encodeURIComponent(params.trseq)}&appr_no=${encodeURIComponent(params.appr_no)}`,
    waitSelector: 'input[name="subject"]',
    waitMs: 2e3
  },
  budget_transfer: {
    customUrl: (params, config) => {
      const btCode = BUDGET_TRANSFER_CODES[params.transfer_type || "rnd"] || BUDGET_TRANSFER_CODES.rnd;
      return `${config.baseUrl}/Document/document_write.php?approve_type=${btCode}`;
    },
    waitSelector: "form input, form select",
    waitMs: 1500
  }
};
function noFinalSubmitNote(result, requestedSubmit, mode) {
  if (!requestedSubmit || mode !== "draft") return result;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return result;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return result;
  }
  const docId = payload?.data?.docId ?? payload?.docId;
  const note = "NO_FINAL_SUBMIT: submission was requested, but this MCP never submits a document for approval itself - it saved a draft instead. Open the document" + (docId ? ` (doc_id: ${docId})` : "") + " and press the groupware's own [Approval Request] / [\uACB0\uC7AC\uC694\uCCAD] button to submit it.";
  if (payload.data && typeof payload.data === "object") {
    payload.data.no_final_submit = note;
  } else {
    payload.no_final_submit = note;
  }
  return textResult(payload);
}
var NO_DRAFT_STATE_FORMS = /* @__PURE__ */ new Set(["card_expense_rd"]);
var FORM_HANDLERS = {
  leave: submitLeave,
  expense: submitExpense,
  working: submitWorking,
  travel: submitTravel,
  travel_request: submitTravelRequest,
  // budget_transfer was missing here (pre-existing, found 2026-10-10 while wiring
  // dry_run: submitBudgetTransfer was dead code, every real call silently fell through
  // to the generic submitGeneric fallback instead - no dedicated field handling, no
  // field-rules check, and no dry_run). Restored.
  budget_transfer: submitBudgetTransfer,
  card_expense: submitCardExpense,
  card_expense_rd: submitCardExpenseRD,
  travel_settlement: submitTravelSettlement,
  leave_return: submitLeaveReturn,
  seminar: submitSeminar,
  overseas_travel: submitOverseasTravel
};
async function handleIpkSubmitForm(sessionManager, config, params) {
  beginRun();
  audit({
    action: "navigate",
    field: String(params.form_type ?? "unknown"),
    mode: params.draft_only === false ? "request" : "draft",
    confirmed: params.confirm_submit === true,
    ok: true
  });
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const page = sessionManager.getPage();
  const formType = params.form_type;
  const policy = checkOrgPolicy(params);
  if (policy.length > 0) {
    for (const v of policy) {
      audit({ action: "refusal", code: `POLICY_${v.rule}`, field: v.fields.join(","), ok: false });
    }
    return textResult({
      error: true,
      code: policy.some((v) => v.rule === "NO_FINAL_SUBMIT") ? "CONFIRMATION_REQUIRED" : "POLICY_VIOLATION",
      message: policy.map((v) => `[${v.rule}] ${v.message}`).join("\n"),
      violations: policy
    });
  }
  if (params.attachment_path) {
    const attachErr = validateAttachmentPath(params.attachment_path);
    if (attachErr) {
      return textResult({ error: true, code: "INVALID_ATTACHMENT", message: attachErr });
    }
  }
  const requestedSubmit = params.draft_only === false;
  const mode = requestedSubmit && NO_DRAFT_STATE_FORMS.has(formType) ? "request" : "draft";
  const remainingMs = sessionManager.getSessionRemainingMs();
  if (remainingMs < 5 * 60 * 1e3) {
    return textResult({
      error: true,
      code: "SESSION_EXPIRING",
      message: `Session expires in ${Math.floor(remainingMs / 1e3)}s. Call ipk_login to refresh before submitting forms.`
    });
  }
  try {
    const navConfig = FORM_NAV_CONFIG[formType];
    let frame;
    if (navConfig?.validate) {
      const validErr = navConfig.validate(params);
      if (typeof validErr === "string") {
        return textResult({ error: true, code: "MISSING_CARD_RECEIPT_REF", message: validErr });
      }
      if (validErr) {
        return textResult({ error: true, ...validErr });
      }
    }
    if (navConfig?.beforeNavigate) {
      const refusal = await navConfig.beforeNavigate(page, params, config, sessionManager);
      sessionManager.touchActivity();
      if (refusal) return textResult({ error: true, ...refusal });
    }
    if (navConfig?.customUrl) {
      const url = navConfig.customUrl(params, config);
      const waitSel = navConfig.waitSelector ?? "form input, form select";
      const mainFrame = page.frame("main_menu");
      if (mainFrame) {
        await mainFrame.goto(url, { timeout: config.navTimeoutMs });
        await mainFrame.waitForLoadState("load");
        await mainFrame.waitForSelector(waitSel, { state: "attached", timeout: 5e3 }).catch(() => null);
        frame = mainFrame;
      } else {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
        frame = page.mainFrame();
        await frame.waitForSelector(waitSel, { state: "attached", timeout: 5e3 }).catch(() => null);
      }
      sessionManager.touchActivity();
      await page.waitForTimeout(navConfig.waitMs ?? 2e3);
    } else {
      frame = await navigateToForm(page, formType, config);
      if (!frame) {
        return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Failed to navigate to form" });
      }
      sessionManager.touchActivity();
    }
    const handler = FORM_HANDLERS[formType];
    if (handler) {
      const result2 = await handler(page, frame, sessionManager, config, params, mode);
      if (NO_DRAFT_STATE_FORMS.has(formType)) {
        return noFinalSubmitNote(result2, requestedSubmit, mode);
      }
      return noFinalSubmitNote(
        await confirmDraftResult(page, config.baseUrl, mode, result2, config.navTimeoutMs),
        requestedSubmit,
        mode
      );
    }
    const templateSchema = loadTemplateFieldSchema(formType);
    if (!templateSchema) {
      return textResult({ error: true, code: "UNKNOWN_FORM", message: `Unknown form type: ${formType}` });
    }
    const result = await submitGeneric(page, frame, sessionManager, config, params, mode, formType, templateSchema);
    return noFinalSubmitNote(
      await confirmDraftResult(page, config.baseUrl, mode, result, config.navTimeoutMs),
      requestedSubmit,
      mode
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "SUBMIT_ERROR", message: msg });
  }
}
async function submitLeave(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const leaveType = params.leave_type || "annual";
  const leaveCode = LEAVE_TYPES[leaveType] || "01";
  const startDate = params.start_date || tomorrow();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "personal";
  const destination = params.destination || "Seoul";
  const substituteName = params.substitute_name || process.env.IPK_SUBSTITUTE_NAME || "N/A";
  const isHourly = params.start_time && params.end_time;
  const usingType = isHourly ? "04" : "01";
  const leaveName = LEAVE_NAMES[leaveType] || "Annual leave";
  let subject;
  if (isHourly) {
    subject = `${leaveName}, ${startDate} ${params.start_time}:00~${params.end_time}:00, ${destination}, ${userInfo.name}`;
  } else {
    subject = `${leaveName}, ${startDate}~${endDate}, ${destination}, ${userInfo.name}`;
  }
  const warnings = [];
  if (leaveCode in ATTACHMENT_REQUIRED_LEAVES) {
    warnings.push(`${leaveName} requires attachment (${ATTACHMENT_REQUIRED_LEAVES[leaveCode]}). Add it manually after draft save.`);
  }
  if (substituteName === "N/A") {
    throw new Error(
      "SUBSTITUTE_REQUIRED: no substitute person configured. Set IPK_SUBSTITUTE_NAME or pass substitute_name. 'N/A' is not a real person and must not reach an approval document."
    );
  }
  const fieldSchema = {
    // Order matters. The form has a delegated change handler on .usrCalendar that rebuilds
    // the leave row, and it clears using_type[]. Setting the dates last therefore wipes a
    // using_type set earlier, and the form answers "Please check your leave period. (6)"
    // with no hint that a field it recomputed is the reason.
    leave_kind: { type: "select", dom_name: "leave_kind[]", required: true },
    begin_date: { type: "date", dom_name: "begin_date[]", required: true },
    end_date: { type: "date", dom_name: "end_date[]", required: true },
    using_type: { type: "select", dom_name: "using_type[]", required: true },
    purpose: { type: "text", dom_name: "purpose", required: false },
    destination: { type: "text", dom_name: "destination", required: false },
    emergency_address: { type: "text", dom_name: "emergency_address", required: false },
    emergency_telephone: { type: "text", dom_name: "emergency_telephone", required: false }
  };
  await genericFillForm(frame, fieldSchema, {
    leave_kind: leaveCode,
    using_type: usingType,
    begin_date: startDate,
    end_date: endDate,
    purpose,
    destination,
    emergency_address: process.env.IPK_EMERGENCY_ADDRESS || "Seoul",
    emergency_telephone: process.env.IPK_EMERGENCY_TELEPHONE || "N/A"
  });
  if (isHourly) {
    await selectExistingOption(frame, 'select[name="start_time[]"]', String(params.start_time), "start_time");
    await page.waitForTimeout(500);
    await selectExistingOption(frame, 'select[name="end_time[]"]', String(params.end_time), "end_time");
    await page.waitForTimeout(500);
  }
  await setRequiredField(frame, 'input[name="subject"]', subject, "subject");
  try {
    const [popup] = await Promise.all([
      page.waitForEvent("popup", { timeout: 1e4 }),
      frame.evaluate(() => {
        window.fnWinOpen("./user_select.php?sel_type=radio");
      })
    ]);
    await popup.waitForLoadState("load");
    await popup.waitForSelector("tr", { timeout: 5e3 }).catch(() => null);
    await popup.waitForTimeout(1e3);
    const selected = await popup.evaluate(
      (name) => {
        const norm2 = (v) => v.normalize("NFKC").replace(/[._]+/g, " ").replace(/\s+/g, " ").trim().toLocaleLowerCase();
        const wanted = norm2(name);
        const matches = [];
        document.querySelectorAll("tr").forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length < 4) return;
          const userName = cells[3]?.textContent?.trim() || "";
          if (userName && norm2(userName) === wanted) {
            matches.push({ row, label: row.textContent?.replace(/\s+/g, " ").trim() || userName });
          }
        });
        if (matches.length === 0) return { found: false, ambiguous: false, candidates: [] };
        if (matches.length > 1) {
          return { found: false, ambiguous: true, candidates: matches.map((m) => m.label).slice(0, 10) };
        }
        const radio = matches[0].row.querySelector('input[type="radio"]');
        if (!radio) return { found: false, ambiguous: false, candidates: [] };
        radio.click();
        return { found: true, ambiguous: false, candidates: [] };
      },
      substituteName
    );
    if (selected.ambiguous) {
      await popup.click('a:has-text("[Close]")').catch(() => {
      });
      throw new Error(
        `SUBSTITUTE_AMBIGUOUS: '${substituteName}' matches ${selected.candidates.length} people in the groupware user list. Refusing to guess. Candidates: ${selected.candidates.join(" | ")}`
      );
    }
    if (selected.found) {
      await popup.click('a:has-text("[Ok]")');
      await page.waitForTimeout(1e3);
    } else {
      const available = await popup.evaluate(() => {
        const names = [];
        document.querySelectorAll("tr").forEach((row) => {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 4) {
            const n = cells[3]?.textContent?.trim();
            if (n) names.push(n);
          }
        });
        return names;
      }).catch(() => []);
      await popup.click('a:has-text("[Close]")').catch(() => {
      });
      throw new Error(
        `SUBSTITUTE_NOT_FOUND: '${substituteName}' is not in the groupware user list. Pass substitute_name exactly as it appears there. Available: ${available.slice(0, 40).join(", ") || "(could not read list)"}`
      );
    }
  } catch (err) {
    if (err instanceof Error && (err.message.startsWith("SUBSTITUTE_NOT_FOUND") || err.message.startsWith("SUBSTITUTE_AMBIGUOUS"))) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `SUBSTITUTE_POPUP_FAILED: could not open or read the substitute picker (${detail}). Refusing to type substitute fields directly - payroll/position/contact would be fabricated.`
    );
  }
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "leave") });
  const leaveRuleRefusal = await checkFieldRulesAgainstForm(frame, "leave");
  if (leaveRuleRefusal) return textResult({ error: true, ...leaveRuleRefusal });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "leave",
      subject,
      message: docId ? `Leave ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Leave ${mode === "draft" ? "draft" : "request"} completed (doc_id could not be extracted)`,
      warning: warnings.length > 0 ? warnings.join(" | ") : void 0
    }
  });
}
async function submitExpense(page, frame, sessionManager, config, params, mode) {
  if (params.amount !== void 0 && (typeof params.amount !== "number" || params.amount <= 0 || !Number.isFinite(params.amount))) {
    return textResult({
      error: true,
      code: "INVALID_AMOUNT",
      message: "Amount must be a positive number"
    });
  }
  const date = params.start_date || params.work_date || todayStr();
  const amount = params.amount || 15e3;
  const amountNoVat = Math.floor(amount / 1.1);
  const vat = amount - amountNoVat;
  const itemName = params.reason || params.purpose || "overtime meal";
  const subject = params.title || `[Card] ${itemName}`;
  const budgetType = params.budget_type || "01";
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }
  const participants = params.participants || "";
  const purpose = params.purpose || "overtime work";
  const pReason = params.reason || `${itemName} - receipt attached`;
  const cascadeSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true }
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: budgetType });
  await page.waitForTimeout(1e3);
  const fieldSchema = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    pay_kind: { type: "select", dom_name: "pay_kind", required: true },
    p_reason: { type: "textarea", dom_name: "p_reason", required: true },
    invoice: { type: "date", dom_name: "invoice[]", required: true },
    item_desc: { type: "text", dom_name: "item_desc[]", required: true },
    item_qty: { type: "text", dom_name: "item_qty[]", required: false },
    item_amount: { type: "text", dom_name: "item_amount[]", required: false },
    item_amount_vat: { type: "text", dom_name: "item_amount_vat[]", required: false },
    ov_member: { type: "text", dom_name: "ov_member", required: false },
    ov_purpose: { type: "text", dom_name: "ov_purpose", required: false }
  };
  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    pay_kind: "04",
    p_reason: pReason,
    invoice: date,
    item_desc: itemName,
    item_qty: "1",
    item_amount: String(amountNoVat),
    item_amount_vat: String(vat),
    ov_member: participants,
    ov_purpose: purpose
  });
  await frame.evaluate(
    (args) => {
      const totalEl = document.getElementsByName("total_amt")[0];
      if (totalEl) {
        totalEl.value = args.total;
        totalEl.dispatchEvent(new Event("input", { bubbles: true }));
        totalEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const ralEl = document.querySelector('input[name="item_amount_ral[]"]');
      if (ralEl) {
        ralEl.value = args.ral;
        ralEl.dispatchEvent(new Event("input", { bubbles: true }));
        ralEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { total: String(amount), ral: String(amount) }
  );
  await assertTotalMatchesItems(frame);
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "expense") });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "expense",
      subject,
      message: docId ? `Expense ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Expense ${mode} completed`,
      warning: !params.attachment_path ? "No attachment provided. Expense forms typically require a receipt." : void 0
    }
  });
}
async function fillWorkingRow(frame, idx, date, hhmm) {
  return frame.evaluate(
    (args) => {
      const dateEl = document.getElementsByName("app_dt[]")[args.idx];
      const selEl = document.getElementsByName("working_time[]")[args.idx];
      if (!dateEl || !selEl) return "no_element";
      const options = Array.from(selEl.options).map((o) => o.value);
      if (!options.includes(args.hhmm)) return "no_option";
      dateEl.value = args.date;
      selEl.value = args.hhmm;
      selEl.dispatchEvent(new Event("change", { bubbles: true }));
      return "ok";
    },
    { idx, date, hhmm }
  );
}
async function submitWorking(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const reason = params.reason;
  if (!reason) {
    return textResult({
      error: true,
      code: "MISSING_REASON",
      message: "reason is required: one English sentence describing the work (min 20 chars; see rules/public/AppFrm-074.json)."
    });
  }
  const rawRows = params.rows;
  const rows = (Array.isArray(rawRows) ? rawRows : []).map((r) => ({
    date: String(r?.date ?? ""),
    hours: Number(r?.hours)
  }));
  const { violations, warnings } = checkWorkingRows(rows);
  if (violations.length > 0) {
    for (const v of violations) audit({ action: "refusal", code: v.code, field: v.fields.join(","), ok: false });
    return textResult({
      error: true,
      code: "FORM_RULE_VIOLATION",
      message: violations.map((v) => `[${v.code}] ${v.message}`).join("\n"),
      violations
    });
  }
  const subject = params.subject || `Application for Working on ${rows[0].date}, ${userInfo.name}`;
  await genericFillForm(
    frame,
    { subject: { type: "text", dom_name: "subject", required: true }, reason: { type: "text", dom_name: "reason", required: true } },
    { subject, reason }
  );
  for (let i = 1; i < rows.length; i++) {
    await frame.locator(".btnAdd").click();
    await page.waitForTimeout(300);
  }
  for (let i = 0; i < rows.length; i++) {
    const hhmm = `${String(rows[i].hours).padStart(2, "0")}:00`;
    const status = await fillWorkingRow(frame, i, rows[i].date, hhmm);
    if (status !== "ok") {
      audit({ action: "refusal", code: `WORKING_ROW_${status.toUpperCase()}`, field: `rows[${i}]`, ok: false });
      return textResult({
        error: true,
        code: "WORKING_ROW_NOT_SET",
        message: `rows[${i}]: could not set app_dt[]/working_time[] (${status}). The form may not have offered '${hhmm}' as an option, or the row wasn't added.`
      });
    }
  }
  await page.waitForTimeout(500);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "working") });
  const workingRuleRefusal = await checkFieldRulesAgainstForm(frame, "working");
  if (workingRuleRefusal) return textResult({ error: true, ...workingRuleRefusal });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "working",
      subject,
      warning: warnings.length > 0 ? warnings.map((w) => w.message).join(" | ") : void 0,
      message: docId ? `Working request ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Working request ${mode} completed`
    }
  });
}
async function submitTravel(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const route = TRAVEL_REPORT_ROUTE.get(params);
  if (!route) {
    throw new Error("TRAVEL_ROUTE_UNRESOLVED: request_doc_id/report_kind were not resolved before navigation - this is a bug, not a caller error.");
  }
  if (route.kind === "domestic") {
    return submitDomesticTravelReport(page, frame, sessionManager, config, params, route.requestDocId);
  }
  return submitOverseasTravelReport(page, frame, sessionManager, config, params, route.requestDocId, mode);
}
async function submitDomesticTravelReport(page, frame, sessionManager, config, params, requestDocId) {
  const userInfo = sessionManager.getUserInfo();
  const profile = loadProfile() ?? void 0;
  const reportPost = process.env.IPK_USER_POSITION || "";
  const reportLeader = profile?.approval_line?.group_leader || process.env.IPK_GROUP_LEADER || "";
  const userDept = userInfo.dept || process.env.IPK_USER_DEPT || "";
  const fields = buildDomesticReportFields(params, userInfo, { reportPost, reportLeader, userDept }, todayStr());
  const existing = await readReportContentFields(frame);
  if (!reportIsEmpty(existing) && params.overwrite_report !== true && !params.dry_run) {
    const filled = REPORT_CONTENT_FIELDS.filter((k) => (existing[k] ?? "").trim().length > 0).map((k) => `${k} (${existing[k].length} chars)`);
    audit({ action: "refusal", code: "REPORT_ALREADY_EXISTS", field: "requestDocId", ok: false });
    return textResult({
      error: true,
      code: "REPORT_ALREADY_EXISTS",
      message: `Approved request ${requestDocId} already has a report: ${filled.join(", ")}. Pass overwrite_report: true to replace it.`
    });
  }
  const overwrittenLengths = !reportIsEmpty(existing) ? Object.fromEntries(REPORT_CONTENT_FIELDS.map((k) => [k, (existing[k] ?? "").length])) : void 0;
  const warnings = [];
  if (!reportLeader) warnings.push("report_leader: not set (profile.approval_line.group_leader / IPK_GROUP_LEADER are both empty) - left blank.");
  if (!reportPost) warnings.push("report_post: not set (IPK_USER_POSITION is empty) - left blank.");
  if (!fields.person_field) warnings.push("person_field (counterparty met): not set (pass persons_met) - left blank.");
  const schema = Object.fromEntries(
    Object.keys(fields).map((name) => [name, { type: "text", dom_name: name, required: false, dom_selector: `[name="${name}"]` }])
  );
  await genericFillForm(frame, schema, fields);
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) {
    const preview = await buildDryRunPreview(page, frame, config, "travel");
    return textResult({
      error: false,
      data: {
        ...preview,
        report_kind: "domestic",
        attached_to_doc_id: requestDocId,
        // Lengths of whatever was already on this request before this (never-saved) fill -
        // the overwrite guard is skipped under dry_run since nothing is written to protect.
        existing_report_lengths: overwrittenLengths,
        warning: [warnings.join(" | "), preview.warnings.join(" | ")].filter(Boolean).join(" | ") || void 0
      }
    });
  }
  const { dialogs } = await submitTravelReportDraft(page, frame);
  const origin = new URL(config.baseUrl).origin;
  await page.goto(`${origin}/Document/travel_report_write.php?doc_id=${encodeURIComponent(requestDocId)}&approve_type=AppFrm-023&pop=Y`, {
    waitUntil: "domcontentloaded",
    timeout: config.navTimeoutMs
  });
  await page.waitForTimeout(1e3);
  const verifyFrame = page.mainFrame();
  const afterReload = await verifyFrame.evaluate((names) => {
    const out = {};
    for (const n of names) {
      const el = document.querySelector(`[name="${n}"]`);
      if (el) out[n] = el.value;
    }
    return out;
  }, Object.keys(fields));
  const saved = Object.entries(fields).every(([k, v]) => afterReload[k] === v);
  return textResult({
    error: false,
    data: {
      success: true,
      // Deliberately not `docId`: confirmDraftResult looks that up in the Drafts/Progress
      // lists, which don't apply here (this attaches to an already-approved document).
      attached_to_doc_id: requestDocId,
      mode: "draft",
      formType: "travel",
      report_kind: "domestic",
      saved_confirmed: saved,
      overwritten_old_lengths: overwrittenLengths,
      warning: warnings.length > 0 ? warnings.join(" | ") : void 0,
      message: saved ? `Domestic travel report draft saved onto approved request ${requestDocId}.` : `Report was filled and Check_Form('D') was called, but re-reading the page afterward did not show all the values saved - check manually.` + (dialogs.length ? ` The form said: ${dialogs.join(" / ")}` : "")
    }
  });
}
async function submitOverseasTravelReport(page, frame, sessionManager, config, params, requestDocId, mode) {
  const userInfo = sessionManager.getUserInfo();
  await selectExistingOption(frame, 'select[name="pdoc_id"]', requestDocId, "pdoc_id");
  const title = params.title || "Business Travel";
  const destination = params.destination || "";
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "Business travel";
  const schedule = params.schedule || `${startDate} ~ ${endDate}`;
  const organization = params.organization || destination;
  const attendees = params.attendees || userInfo.name;
  const reportDate = todayStr();
  const reportPost = process.env.IPK_USER_POSITION || "";
  const reportLeader = process.env.IPK_GROUP_LEADER || "";
  const userDept = userInfo.dept || process.env.IPK_USER_DEPT || "";
  const travelSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    report_date: { type: "date", dom_name: "report_date", required: true, dom_selector: '.validate[name="report_date"]' },
    report_name: { type: "text", dom_name: "report_name", required: true, dom_selector: '.validate[name="report_name"]' },
    report_post: { type: "text", dom_name: "report_post", dom_selector: '.validate[name="report_post"]' },
    report_group: { type: "text", dom_name: "report_group", dom_selector: '.validate[name="report_group"]' },
    report_leader: { type: "text", dom_name: "report_leader", dom_selector: '.validate[name="report_leader"]' },
    // Live-confirmed field names on AppFrm-076, 2026-10-09: start_day/end_day, not
    // start_date/end_date - the old names silently never landed on anything.
    start_date: { type: "date", dom_name: "start_day", required: true, dom_selector: '[name="start_day"]' },
    end_date: { type: "date", dom_name: "end_day", required: true, dom_selector: '[name="end_day"]' },
    report_dest: { type: "text", dom_name: "report_dest", required: true, dom_selector: '.validate[name="report_dest"]' },
    purpose_field: { type: "text", dom_name: "purpose_field", required: true, dom_selector: '.validate[name="purpose_field"]' },
    date_field: { type: "text", dom_name: "date_field", dom_selector: '.validate[name="date_field"]' },
    org_field: { type: "text", dom_name: "org_field", dom_selector: '.validate[name="org_field"]' },
    person_field: { type: "text", dom_name: "person_field", dom_selector: '.validate[name="person_field"]' },
    discuss_field: { type: "text", dom_name: "discuss_field", dom_selector: '.validate[name="discuss_field"]' },
    agenda_field: { type: "text", dom_name: "agenda_field", dom_selector: '.validate[name="agenda_field"]' },
    result_field: { type: "text", dom_name: "result_field", dom_selector: '.validate[name="result_field"]' },
    other_field: { type: "text", dom_name: "other_field", dom_selector: '.validate[name="other_field"]' },
    conclusion_field: { type: "text", dom_name: "conclusion_field", dom_selector: '.validate[name="conclusion_field"]' }
  };
  await genericFillForm(frame, travelSchema, {
    subject: title,
    report_date: reportDate,
    report_name: userInfo.name,
    report_post: reportPost,
    report_group: userDept,
    report_leader: reportLeader,
    start_date: startDate,
    end_date: endDate,
    report_dest: destination,
    purpose_field: purpose,
    date_field: schedule,
    org_field: organization,
    person_field: attendees,
    discuss_field: params.details || purpose,
    agenda_field: params.schedule || purpose,
    result_field: params.reason || `Expected outcomes: ${purpose}`,
    other_field: "N/A",
    conclusion_field: params.destination ? `${purpose} at ${destination}` : `Travel for ${purpose}`
  });
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "travel") });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "form_submit");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "travel",
      report_kind: "overseas",
      subject: title,
      message: docId ? `Travel ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Travel ${mode} completed`
    }
  });
}
async function submitTravelRequest(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const title = params.title || "Business Travel Request";
  const destination = params.destination || "";
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const purpose = params.purpose || "Business travel";
  const budgetType = params.budget_type || "02";
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }
  const subject = /^\[request\]/i.test(title.trim()) ? title.trim() : `[Request] ${title}`;
  const cascadeSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true }
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: budgetType });
  await page.waitForTimeout(1e3);
  const fieldSchema = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    start_date: { type: "date", dom_name: "start_date", required: true, dom_selector: '[name="start_date"]' },
    end_date: { type: "date", dom_name: "end_date", required: true, dom_selector: '[name="end_date"]' },
    // These are the travel *request* form's own fields (form_templates/AppFrm-023.json,
    // captured from 108 documents). The schema previously carried report_dest /
    // purpose_field / org_field / person_field / date_field / discuss_field, which belong
    // to the travel *report* (AppFrm-076) and do not exist here - so every one of them
    // silently did nothing, and the submission failed on the first required one.
    travel_dest: { type: "text", dom_name: "travel_dest[]", required: true, dom_selector: '[name="travel_dest[]"]' },
    purpose: { type: "text", dom_name: "purpose", required: true, dom_selector: '[name="purpose"]' },
    start_tm: { type: "select", dom_name: "start_tm" },
    end_tm: { type: "select", dom_name: "end_tm" }
  };
  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    start_date: startDate,
    end_date: endDate,
    travel_dest: destination,
    purpose,
    start_tm: params.start_tm || "",
    end_tm: params.end_tm || ""
  });
  if (params.purpose_type) {
    await selectRadio(frame, "purpose_type", String(params.purpose_type));
  }
  if (params.matrials) {
    await selectRadio(frame, "matrials", String(params.matrials));
  }
  if (params.bound_code) {
    await setRequiredSelect(frame, 'select[name="bound_code"]', String(params.bound_code), "bound_code");
  }
  if (params.working_code) {
    await setRequiredSelect(frame, 'select[name="working_code"]', String(params.working_code), "working_code");
  }
  if (params.province_code) {
    await selectExistingOption(frame, 'select[name="province_code"]', String(params.province_code), "province_code");
    if (params.city_code) {
      await selectExistingOption(frame, 'select[name="city_code"]', String(params.city_code), "city_code");
      if (params.travel_type_code) {
        await selectExistingOption(
          frame,
          'select[name="travel_type_code"]',
          String(params.travel_type_code),
          "travel_type_code"
        );
      }
    }
  }
  if (params.meals_served != null && params.meals_served !== "") {
    const meals = String(params.meals_served);
    await selectRadio(frame, "food_yn", meals === "N" ? "N" : "Y");
    if (meals !== "N") {
      await selectExistingOption(frame, 'select[name="food_ex_cnt"]', meals, "food_ex_cnt");
    }
  }
  if (params.credit_card_no) {
    const parts = parseCardNo(String(params.credit_card_no));
    for (let i = 0; i < 4; i++) {
      await setRequiredField(frame, `input[name="copcard${i + 1}"]`, parts[i], `copcard${i + 1}`);
    }
  }
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path, slotSelector(params.attachment_slot));
    await page.waitForTimeout(1e3);
  }
  await verifySelectsHeld(frame, [
    ["bound_code", params.bound_code],
    ["working_code", params.working_code],
    ["province_code", params.province_code],
    ["city_code", params.city_code],
    ["travel_type_code", params.travel_type_code],
    ["start_tm", params.start_tm],
    ["end_tm", params.end_tm]
  ]);
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "travel_request") });
  const travelRequestRuleRefusal = await checkFieldRulesAgainstForm(frame, "travel_request");
  if (travelRequestRuleRefusal) return textResult({ error: true, ...travelRequestRuleRefusal });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  const precedentSet = PRECEDENT_FOR.get(params);
  let precedent;
  if (precedentSet) {
    precedent = {
      n: precedentSet.docs.length,
      docs: precedentSet.docs.map((d) => `${d.docNo} (${d.writer})`),
      excluded_tool_drafts: precedentSet.excluded,
      error: precedentSet.error,
      practice: precedentSet.profile.stable,
      varied: precedentSet.profile.varied
    };
    if (docId && mode === "draft" && precedentSet.docs.length >= 2) {
      const read = await readDraftText(page, config.baseUrl, docId).catch((e) => ({ text: null, reason: String(e) }));
      if (read.text) precedent.diff = diffAgainstPractice(parseTravelRequestDoc(read.text), precedentSet.profile);
      else precedent.diff_unavailable = read.reason;
    }
  }
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "travel_request",
      subject,
      message: docId ? `Travel request ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Travel request ${mode} completed`,
      precedent
    }
  });
}
async function submitBudgetTransfer(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const transferType = params.transfer_type || "rnd";
  const fromBudget = params.from_budget_code || "";
  const toBudget = params.to_budget_code || "";
  const amount = params.transfer_amount || params.amount || 0;
  const reason = params.reason || params.purpose || "Budget reallocation";
  const title = params.title || `Budget Transfer: ${fromBudget} -> ${toBudget}`;
  if (amount !== void 0 && amount !== 0 && (typeof amount !== "number" || amount <= 0 || !Number.isFinite(amount))) {
    return textResult({
      error: true,
      code: "INVALID_AMOUNT",
      message: "Transfer amount must be a positive number"
    });
  }
  const subject = `[Budget Transfer] ${title}`;
  const fieldSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_code: { type: "text", dom_name: "budget_code" },
    source_account: { type: "text", dom_name: "source_account" },
    target_account: { type: "text", dom_name: "target_account" },
    amount1: { type: "text", dom_name: "amount1" },
    contents_data: { type: "text", dom_name: "contents_data" }
  };
  await genericFillForm(frame, fieldSchema, {
    subject,
    budget_code: params.budget_code || void 0,
    source_account: fromBudget || void 0,
    target_account: toBudget || void 0,
    amount1: amount || void 0,
    contents_data: reason
  });
  await page.waitForTimeout(1e3);
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "budget_transfer") });
  const budgetTransferRuleRefusal = await checkFieldRulesAgainstForm(frame, "budget_transfer");
  if (budgetTransferRuleRefusal) return textResult({ error: true, ...budgetTransferRuleRefusal });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "budget_transfer",
      subject,
      transferType,
      message: docId ? `Budget transfer ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Budget transfer ${mode} completed`,
      note: "Field selectors are best-effort. After first use, verify the form was filled correctly via screenshot tool and report any missing fields."
    }
  });
}
async function submitCardExpense(page, frame, sessionManager, config, params, mode) {
  if (params.amount !== void 0 && (typeof params.amount !== "number" || params.amount <= 0 || !Number.isFinite(params.amount))) {
    return textResult({ error: true, code: "INVALID_AMOUNT", message: "Amount must be a positive number" });
  }
  const date = params.item_date || params.start_date || todayStr();
  const amount = params.amount || 0;
  const amountNoVat = Math.floor(amount / 1.1);
  const vat = amount - amountNoVat;
  const itemDesc = params.item_description || "Team activities";
  const accountCode = params.item_account_code || "420421";
  const vendor = params.item_vendor || "";
  const controlNo = params.item_control_no || "";
  const subject = params.title || `[Card] ${itemDesc}`;
  const budgetCode = params.budget_code;
  if (!budgetCode) {
    return textResult({ error: true, code: "MISSING_BUDGET_CODE", message: "budget_code is required. Provide the active fiscal year budget code (e.g. NN2612-0001)." });
  }
  const participants = params.participants || "";
  const venue = params.venue || "";
  const purposeMinutes = params.purpose_minutes || params.purpose || "";
  const pReason = params.reason || `${itemDesc} - receipt attached`;
  const cascadeSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_type: { type: "select", dom_name: "budget_type", required: true }
  };
  await genericFillForm(frame, cascadeSchema, { subject, budget_type: "02" });
  await page.waitForTimeout(1e3);
  const fieldSchema = {
    budget_code: { type: "select", dom_name: "budget_code", required: true },
    pay_kind: { type: "select", dom_name: "pay_kind", required: true },
    card_no: { type: "text", dom_name: "card_no", required: false },
    p_reason: { type: "textarea", dom_name: "p_reason", required: true },
    invoice: { type: "date", dom_name: "invoice[]", required: true },
    item_desc: { type: "text", dom_name: "item_desc[]", required: true },
    item_qty: { type: "text", dom_name: "item_qty[]", required: false },
    item_amount: { type: "text", dom_name: "item_amount[]", required: false },
    item_amount_vat: { type: "text", dom_name: "item_amount_vat[]", required: false },
    item_account_code: { type: "select", dom_name: "item_account_code[]", required: false },
    item_vendor: { type: "text", dom_name: "item_vendor[]", required: false },
    item_control_no: { type: "text", dom_name: "item_control_no[]", required: false },
    ov_member: { type: "text", dom_name: "ov_member", required: false },
    ov_purpose: { type: "text", dom_name: "ov_purpose", required: false },
    ov_place: { type: "text", dom_name: "ov_place", required: false }
  };
  const cardNo = params.corp_card_no || process.env.IPK_CORP_CARD_NO || "";
  await genericFillForm(frame, fieldSchema, {
    budget_code: budgetCode,
    pay_kind: "04",
    // 04 = Corp Card
    card_no: cardNo,
    p_reason: pReason,
    invoice: date,
    item_desc: itemDesc,
    item_qty: "1",
    item_amount: String(amountNoVat),
    item_amount_vat: String(vat),
    item_account_code: accountCode,
    item_vendor: vendor,
    item_control_no: controlNo,
    ov_member: participants,
    ov_purpose: purposeMinutes,
    ov_place: venue
  });
  await frame.evaluate(
    (args) => {
      const totalEl = document.getElementsByName("total_amt")[0];
      if (totalEl) {
        totalEl.value = args.total;
        totalEl.dispatchEvent(new Event("input", { bubbles: true }));
        totalEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const ralEl = document.querySelector('input[name="item_amount_ral[]"]');
      if (ralEl) {
        ralEl.value = args.ral;
        ralEl.dispatchEvent(new Event("input", { bubbles: true }));
        ralEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    { total: String(amount), ral: String(amount) }
  );
  await assertTotalMatchesItems(frame);
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "card_expense") });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "card_expense",
      subject,
      message: docId ? `Card expense ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Card expense ${mode} completed`,
      warning: !params.attachment_path ? "No attachment provided. Card expense forms require a receipt." : void 0
    }
  });
}
async function submitCardExpenseRD(page, frame, _sessionManager, config, params, mode) {
  const accountHelper = await Promise.resolve().then(() => (init_account(), account_exports));
  const attachmentHelper = await Promise.resolve().then(() => (init_attachment(), attachment_exports));
  const subject = normalizeCardSubject(params.subject || params.title || "Card receipt");
  const itemName = params.item_name || "Card receipt item";
  const sellerEn = params.seller_en || params.item_vendor || "";
  const pReason = params.p_reason || params.reason || "";
  const prefilled = await frame.evaluate(() => {
    const get = (n, idx = 0) => {
      const els = document.querySelectorAll(`[name="${n}"]`);
      return els[idx] ? els[idx].value : null;
    };
    return {
      budget_type: get("budget_type"),
      budget_code: get("budget_code"),
      amount: get("item_amount[]", 1),
      vender_kor: get("vender[]", 1)
    };
  });
  if (!prefilled.budget_code) {
    const frameUrl = typeof frame.url === "function" ? frame.url() : "";
    const frames = page.frames().map((f) => `${f.name() || "-"}=${f.url()}`);
    return textResult({
      error: true,
      code: "FORM_NOT_LOADED",
      message: "AppFrm-021 mker form did not prefill. Check trseq/appr_no values.",
      diagnostics: { frameUrl, frames, prefilled }
    });
  }
  let effectiveBudgetCode = prefilled.budget_code;
  if (params.budget_code) {
    try {
      await setSelectValue(frame, 'select[name="budget_code"]', params.budget_code);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return textResult({
        error: true,
        code: "BUDGET_CODE_NOT_OFFERED",
        message: `budget_code '${params.budget_code}' is not offered by this form. ${msg}`
      });
    }
    effectiveBudgetCode = await frame.evaluate(() => {
      const el = document.querySelector('select[name="budget_code"]');
      return el ? el.value : null;
    });
  }
  await frame.evaluate(
    (args) => {
      const subjectEl = document.querySelector('input[name="subject"]');
      if (subjectEl) subjectEl.value = args.subject;
      if (args.notes) {
        const notesEl = document.getElementById("notes") || document.querySelector('[name="notes"]');
        if (notesEl) notesEl.value = args.notes;
      }
      for (const [k, v] of Object.entries(args.event)) {
        if (!v) continue;
        const el = document.getElementById(k) || document.querySelector(`[name="${k}"]`);
        if (el) el.value = v;
      }
      const items = document.querySelectorAll('input[name="item_name[]"]');
      const qtys = document.querySelectorAll('input[name="item_qty[]"]');
      const sellers = document.querySelectorAll('input[name="seller[]"]');
      const itemDescs = document.querySelectorAll('input[name="item_desc[]"]');
      if (items[1]) items[1].value = args.itemName;
      if (qtys[1] && !qtys[1].value) qtys[1].value = "1";
      if (sellers[1]) sellers[1].value = args.sellerEn;
      if (itemDescs[1]) itemDescs[1].value = "";
      const pr = document.querySelectorAll('textarea[name="p_reason"]');
      pr.forEach((t) => {
        t.value = args.pReason;
      });
      if (args.venue) {
        const venues = document.getElementsByName("venue[]");
        if (venues[1]) venues[1].value = args.venue;
      }
      if (args.participants) {
        const participantsEls = document.getElementsByName("participants[]");
        if (participantsEls[1]) participantsEls[1].value = args.participants;
      }
      if (args.purposeMinutes) {
        const purposeEls = document.getElementsByName("purpose[]");
        if (purposeEls[1]) purposeEls[1].value = args.purposeMinutes;
      }
      if (args.meetingBegin) {
        const begins = document.getElementsByName("meeting_begin_date[]");
        if (begins[1]) begins[1].value = args.meetingBegin;
      }
      if (args.meetingEnd) {
        const ends = document.getElementsByName("meeting_end_date[]");
        if (ends[1]) ends[1].value = args.meetingEnd;
      }
    },
    {
      subject,
      itemName,
      sellerEn,
      pReason,
      venue: params.venue || "",
      participants: params.participants || "",
      purposeMinutes: params.purpose_minutes || params.purpose || "",
      meetingBegin: params.meeting_begin || "",
      meetingEnd: params.meeting_end || "",
      notes: params.notes || pReason,
      event: {
        org_name: params.event_name || "",
        dmex_se_cd: params.event_type || "",
        organizer_nm: params.organizer || "",
        edu_start_day: params.event_start || "",
        edu_end_day: params.event_end || "",
        edu_member: params.attendees || ""
      }
    }
  );
  let accountSet = false;
  if (params.item_account_code) {
    const codes = await accountHelper.fetchAccountCodes(page, {
      baseUrl: config.baseUrl,
      budgetType: prefilled.budget_type || "02",
      budgetCode: effectiveBudgetCode,
      approveType: "AppFrm-021"
    });
    const match = codes.find((c) => c.code === params.item_account_code);
    if (match) {
      await frame.evaluate(
        (args) => {
          const acStr = document.getElementsByName("account_str[]");
          const acCode = document.getElementsByName("account_code[]");
          const acSeq = document.getElementsByName("account_seq[]");
          const msSeq = document.getElementsByName("milestone_seq[]");
          const msChk = document.getElementsByName("milestone_check");
          if (acStr[args.rowIdx]) acStr[args.rowIdx].value = `[${args.account.code}] ${args.account.label}`;
          if (acCode[args.rowIdx]) acCode[args.rowIdx].value = args.account.code;
          if (acSeq[args.rowIdx]) acSeq[args.rowIdx].value = args.account.seq;
          if (msSeq[args.rowIdx]) msSeq[args.rowIdx].value = "";
          if (msChk[args.rowIdx]) msChk[args.rowIdx].value = "-";
        },
        { rowIdx: 1, account: match }
      );
      accountSet = true;
    }
  }
  if (!accountSet && params.account_code_label) {
    const codes = await accountHelper.fetchAccountCodes(page, {
      baseUrl: config.baseUrl,
      budgetType: prefilled.budget_type || "02",
      budgetCode: effectiveBudgetCode,
      approveType: "AppFrm-021"
    });
    const labelLower = String(params.account_code_label).toLowerCase();
    const match = codes.find((c) => c.label.toLowerCase().includes(labelLower));
    if (match) {
      await frame.evaluate(
        (args) => {
          const acStr = document.getElementsByName("account_str[]");
          const acCode = document.getElementsByName("account_code[]");
          const acSeq = document.getElementsByName("account_seq[]");
          const msSeq = document.getElementsByName("milestone_seq[]");
          const msChk = document.getElementsByName("milestone_check");
          if (acStr[args.rowIdx]) acStr[args.rowIdx].value = `[${args.account.code}] ${args.account.label}`;
          if (acCode[args.rowIdx]) acCode[args.rowIdx].value = args.account.code;
          if (acSeq[args.rowIdx]) acSeq[args.rowIdx].value = args.account.seq;
          if (msSeq[args.rowIdx]) msSeq[args.rowIdx].value = "";
          if (msChk[args.rowIdx]) msChk[args.rowIdx].value = "-";
        },
        { rowIdx: 1, account: match }
      );
      accountSet = true;
    }
  }
  if (!accountSet) {
    return textResult({
      error: true,
      code: "ACCOUNT_CODE_REQUIRED",
      message: "card_expense_rd: provide item_account_code (e.g. '410318') or account_code_label (e.g. 'IT Software'). Use ipk_inspect_form or ./pr_account_sel.php to list valid codes for the budget."
    });
  }
  const filedAccount = await frame.evaluate(() => {
    const el = document.getElementsByName("account_code[]")[1];
    return el ? el.value : "";
  });
  if (isMeetingAccount(filedAccount)) {
    await frame.evaluate(() => {
      for (const n of ["item_name[]", "item_desc[]"]) {
        const el = document.getElementsByName(n)[1];
        if (el) {
          el.value = "";
          el.style.display = "none";
        }
      }
      for (const n of ["er_tr1", "er_tr2", "er_tr3", "er_tr4", "er_tr5", "er_tr6", "er_tr7", "er_tr8"]) {
        const row = document.getElementsByName(n)[0];
        if (row) row.style.display = "";
      }
    });
  }
  if (isOvertimeAccount(filedAccount)) {
    const userInfo = _sessionManager.getUserInfo();
    const ovMember = userInfo?.name || "";
    const ovMemberId = userInfo?.username || "";
    await frame.evaluate(
      (args) => {
        const info = document.getElementById("overtime_info");
        if (info) info.style.display = "";
        const begin = document.getElementById("overtime_start_day");
        if (begin) begin.value = args.begin;
        const end = document.getElementById("overtime_end_day");
        if (end) end.value = args.end;
        const member = document.getElementById("ov_member");
        if (member) member.value = args.member;
        const memberId = document.getElementById("ov_member_id");
        if (memberId) memberId.value = args.memberId;
        const purpose = document.getElementById("ov_purpose");
        if (purpose) purpose.value = args.purpose;
      },
      {
        begin: params.overtime_begin || "",
        end: params.overtime_end || "",
        purpose: params.overtime_purpose || "",
        member: ovMember,
        memberId: ovMemberId
      }
    );
  }
  if (isOverseasItSubscription(itemName)) {
    await frame.evaluate(() => {
      const vat = document.getElementsByName("item_amount_vat[]")[1];
      const total = document.getElementsByName("item_amount[]")[1];
      const excl = document.getElementsByName("item_amount_ral1[]")[1];
      if (vat) vat.value = "0";
      if (excl && total) excl.value = total.value;
    });
  }
  const labeledAttachments = Array.isArray(params.attachments) ? params.attachments : [];
  const legacyAttachmentPaths = Array.isArray(params.attachment_paths) ? params.attachment_paths : params.attachment_path ? [params.attachment_path] : [];
  const attachmentReview = reviewAttachments({
    accountCode: filedAccount,
    attachments: labeledAttachments,
    legacyPaths: labeledAttachments.length === 0 ? legacyAttachmentPaths : [],
    eventStart: params.event_start,
    eventEnd: params.event_end,
    totalAmount: prefilled.amount ? Number(prefilled.amount) : void 0,
    issuerName: params.organizer || params.seller_en || prefilled.vender_kor || void 0,
    exceptions: params.attestation_exception
  });
  audit({
    action: "attachment_review",
    field: "card_expense_rd",
    ok: attachmentReview.blocks.length === 0,
    value: JSON.stringify({ blocks: attachmentReview.blocks, warnings: attachmentReview.warnings, flagged: attachmentReview.flagged, records: attachmentReview.auditRecords })
  });
  if (attachmentReview.blocks.length > 0) {
    return textResult({
      error: true,
      code: "ATTACHMENT_REVIEW_BLOCKED",
      message: attachmentReview.blocks.join("\n"),
      blocks: attachmentReview.blocks,
      warnings: attachmentReview.warnings
    });
  }
  const filePaths = labeledAttachments.length > 0 ? labeledAttachments.map((a) => a.path) : legacyAttachmentPaths;
  if (filePaths.length === 0) {
    return textResult({
      error: true,
      code: "ATTACHMENT_REQUIRED",
      message: "card_expense_rd requires at least one attachment_path or attachment_paths[]. The form alerts 'Please attach at least one file.' on submit."
    });
  }
  for (const fp of filePaths) {
    const pathErr = validateAttachmentPath(fp);
    if (pathErr) {
      return textResult({ error: true, code: "INVALID_ATTACHMENT", message: `${fp}: ${pathErr}` });
    }
  }
  const attachResult = await attachmentHelper.attachFiles(frame, filePaths);
  await page.waitForTimeout(500);
  if (params.dry_run) {
    const dryRunFieldRuleResult = await checkFieldRulesRaw(frame, "card_expense_rd") ?? { blocks: [], warnings: [] };
    const preview = await previewCardExpenseRD(page, frame, config, { subject, effectiveBudgetCode, attachResult, fileCount: filePaths.length });
    const parsed = JSON.parse(preview.content[0].text);
    if (parsed.data) {
      parsed.data.dry_run = true;
      parsed.data.field_rule_result = dryRunFieldRuleResult;
    } else {
      parsed.field_rule_result = dryRunFieldRuleResult;
    }
    return textResult(parsed);
  }
  const cardRdRuleRefusal = await checkFieldRulesAgainstForm(frame, "card_expense_rd");
  if (cardRdRuleRefusal) {
    return textResult({
      error: true,
      ...cardRdRuleRefusal,
      field_rule_result: { blocks: cardRdRuleRefusal.violations, warnings: [] }
    });
  }
  if (mode === "draft" && params.allow_card_er_save === true) {
    const authFile = cardErAuthorizationPath();
    let authorization = null;
    try {
      authorization = consumeCardErDraftAuthorization(params.appr_no, params.trseq, authFile);
    } catch (err) {
      return textResult({
        error: true,
        code: "CARD_ER_SAVE_REFUSED",
        message: `The authorization for appr_no ${params.appr_no} could not be consumed (${err instanceof Error ? err.message : String(err)}), so the save was refused. Nothing was clicked and nothing was filed.`
      });
    }
    if (!authorization) {
      return textResult({
        error: true,
        code: "CARD_ER_SAVE_REFUSED",
        message: `allow_card_er_save is refused without a one-time authorization for this card transaction: ${authFile} has no entry "${params.appr_no}" with trseq "${params.trseq}". A person adds { "<appr_no>": { "trseq": "<trseq>", "authorized_at": "<ISO>", "note": "..." } } to that file; the tool consumes the entry before clicking, so each entry allows one save attempt. The [Draft] path submitted doc 302098 for approval on 2026-10-23 instead of saving a draft and may do so again. Without an authorization, run dry_run=true, review the screenshot, then press [Draft] in the browser yourself. Nothing was saved.`
      });
    }
    audit({ action: "draft_save", code: "AUTHORIZATION_CONSUMED", field: "card_expense_rd", mode: "draft", value: JSON.stringify({ appr_no: String(params.appr_no), ...authorization }), ok: true });
    return await saveCardExpenseRDDraft(page, frame, config, { subject, effectiveBudgetCode, attachResult, fileCount: filePaths.length });
  }
  if (mode === "draft") {
    return await previewCardExpenseRD(page, frame, config, { subject, effectiveBudgetCode, attachResult, fileCount: filePaths.length });
  }
  return textResult({
    error: true,
    code: "CARD_ER_NO_SUBMIT",
    message: "card_expense_rd is preview-only in this tool: run dry_run=true, review the screenshot, and press [Draft]/[Request] in the browser yourself. Nothing was filed."
  });
}
function installCardErStubs(preview) {
  const w = window;
  const st = { alerts: [], confirms: [], confirmButtons: [], pressed: null, opens: [], submits: [], jquery: false, pageError: null };
  w.__ipkCardEr = st;
  const text = (v) => String(v ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  w.alert = (msg) => {
    st.alerts.push(text(msg));
  };
  const nativeConfirm = w.confirm;
  w.confirm = (msg) => {
    st.confirms.push(text(msg));
    return preview ? true : nativeConfirm.call(w, msg);
  };
  const dummy = { close: () => {
  }, open: () => {
  }, toggle: () => {
  }, setContent: () => {
  }, setTitle: () => {
  }, $content: null, buttons: {} };
  const pressConfirm = (opts) => {
    const buttons = opts && typeof opts === "object" ? opts.buttons : null;
    if (buttons && typeof buttons === "object") {
      const entries = Object.keys(buttons).map((k) => {
        const v = buttons[k];
        const label = v && typeof v === "object" && v.text ? text(v.text) : k;
        const fn = typeof v === "function" ? v : v && typeof v.action === "function" ? v.action : null;
        return { label, fn };
      });
      st.confirmButtons = entries.map((e) => e.label);
      if (!preview && !/evidence check/i.test(text(opts.title))) return dummy;
      const pick = entries.find((e) => /^\s*next\s*$/i.test(e.label)) || entries.find((e) => !/cancel|close|^\s*no\s*$/i.test(e.label));
      if (pick && pick.fn) {
        st.pressed = pick.label;
        pick.fn.call(dummy);
      }
    } else if (opts && typeof opts.confirm === "function") {
      st.confirmButtons = [text(opts.confirmButton || "confirm")];
      if (!preview && !/evidence check/i.test(text(opts.title))) return dummy;
      st.pressed = st.confirmButtons[0];
      opts.confirm.call(dummy);
    }
    return dummy;
  };
  const jqAlert = (opts) => {
    st.alerts.push(text(opts && typeof opts === "object" ? opts.content || opts.title : opts));
    return dummy;
  };
  for (const jq of [w.jQuery, w.$]) {
    if (jq && (typeof jq === "function" || typeof jq === "object")) {
      st.jquery = true;
      jq.confirm = pressConfirm;
      jq.alert = jqAlert;
    }
  }
  if (!preview) return;
  w.open = (url, name) => {
    st.opens.push(String(name || url || ""));
    return { closed: false, close: () => {
    }, focus: () => {
    }, document: { write: () => {
    }, close: () => {
    } }, location: {} };
  };
  const capture = function() {
    const entries = [];
    new FormData(this).forEach((v, k) => entries.push([k, typeof v === "string" ? v : `file:${v.name}`]));
    st.submits.push({ action: this.getAttribute("action") || "", target: this.getAttribute("target") || "", entries });
  };
  HTMLFormElement.prototype.submit = capture;
  HTMLFormElement.prototype.requestSubmit = capture;
  const f = document.form1;
  if (f) {
    try {
      f.submit = capture;
    } catch {
    }
  }
  document.addEventListener("submit", (e) => {
    e.preventDefault();
    capture.call(e.target);
  }, true);
}
function runCheckFormRequest() {
  const w = window;
  const st = w.__ipkCardEr;
  try {
    if (typeof w.Check_Form_Request !== "function") throw new Error("Check_Form_Request is not defined on this page");
    w.Check_Form_Request("insert");
  } catch (err) {
    st.pageError = err instanceof Error ? err.message : String(err);
  }
  return JSON.parse(JSON.stringify(st));
}
function readCardErMode1() {
  const els = new Set(Array.from(document.getElementsByName("mode1")));
  const byId = document.getElementById("mode1");
  if (byId) els.add(byId);
  return Array.from(els).map((el) => String(el.value ?? ""));
}
function setCardErDraftMode1(value = "draft") {
  const els = new Set(Array.from(document.getElementsByName("mode1")));
  const byId = document.getElementById("mode1");
  if (byId) els.add(byId);
  const list = Array.from(els);
  if (list.length === 1) list[0].value = value;
  return list.map((el) => String(el.value ?? ""));
}
async function previewCardExpenseRD(page, frame, config, ctx) {
  const blocked = [];
  const onRoute = (route) => {
    const req = route.request();
    if (isPreviewBlockedRequest(req.method(), req.url())) {
      blocked.push(`${req.method()} ${req.url()}`);
      return route.abort();
    }
    return typeof route.fallback === "function" ? route.fallback() : route.continue();
  };
  const context = typeof page.context === "function" ? page.context() : null;
  let run = null;
  let runError = null;
  let screenshot = null;
  let pageRouted = false;
  let contextRouted = false;
  try {
    await page.route("**/*", onRoute);
    pageRouted = true;
    if (context) {
      await context.route("**/*", onRoute);
      contextRouted = true;
    }
    try {
      await frame.evaluate(installCardErStubs, true);
      run = await frame.evaluate(runCheckFormRequest);
      await page.waitForTimeout(1500);
      run = await frame.evaluate(() => JSON.parse(JSON.stringify(window.__ipkCardEr)));
    } catch (err) {
      runError = err instanceof Error ? err.message : String(err);
    }
    try {
      fs7.mkdirSync(config.screenshotDir, { recursive: true, mode: 448 });
      const file = path4.join(config.screenshotDir, `card-er-preview-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.png`);
      const vp = page.viewportSize();
      try {
        if (vp) await page.setViewportSize({ width: vp.width, height: 4e3 });
        await page.screenshot({ path: file, fullPage: true });
      } finally {
        if (vp) await page.setViewportSize(vp);
      }
      screenshot = file;
    } catch {
    }
  } finally {
    await page.goto("about:blank").catch(() => {
    });
    if (pageRouted) await page.unroute("**/*", onRoute).catch(() => {
    });
    if (contextRouted) await context.unroute("**/*", onRoute).catch(() => {
    });
  }
  const alerts = run?.alerts ?? [];
  const submits = run?.submits ?? [];
  const lastSubmit = submits.length > 0 ? submits[submits.length - 1] : null;
  const captured = lastSubmit ? summarizeCapturedForm(lastSubmit.entries) : null;
  const pageError = runError ?? run?.pageError ?? null;
  const wouldSubmit = alerts.length === 0 && !pageError && submits.length > 0;
  const capturedSubject = typeof captured?.subject === "string" ? captured.subject : null;
  audit({ action: "refusal", code: "CARD_ER_PREVIEW_ONLY", field: "card_expense_rd", ok: true });
  return textResult({
    error: false,
    data: {
      success: false,
      saved: false,
      mode: "preview",
      formType: "card_expense_rd",
      docId: null,
      would_submit: wouldSubmit,
      validation_alerts: alerts,
      page_error: pageError,
      message: "AppFrm-021 card ER is preview-only in this tool \u2014 it is never saved or submitted here. The form has its own [Draft] button (saves to the person's own drafts \u2014 server behaviour still being verified) and [Request] button (submits). Nothing was saved. Review the preview; the person presses [Draft] or [Request] themselves." + (alerts.length > 0 ? ` The form's own validation refused it: ${alerts.join(" / ")}` : "") + (!wouldSubmit && alerts.length === 0 ? ` The form did not reach its submit${pageError ? ` (${pageError})` : ""}.` : ""),
      subject_filled: ctx.subject,
      subject_as_form_would_file: capturedSubject,
      subject_double_prefix: capturedSubject !== null && capturedSubject !== normalizeCardSubject(capturedSubject),
      budgetCode: ctx.effectiveBudgetCode,
      captured,
      captured_action: lastSubmit ? lastSubmit.action : null,
      confirm: { jquery_found: run?.jquery ?? false, buttons: run?.confirmButtons ?? [], pressed: run?.pressed ?? null },
      native_confirms: run?.confirms ?? [],
      blocked_requests: blocked,
      attached: ctx.attachResult.attached,
      skipped_attachments: ctx.attachResult.skipped,
      attachment_note: `${ctx.attachResult.attached}/${ctx.fileCount} files set on the form's file inputs; none were uploaded (uploads happen only when the form is filed).`,
      screenshot
    }
  });
}
async function saveCardExpenseRDDraft(page, frame, config, ctx, flow = { mode1: "draft", runner: runCheckFormRequest }) {
  const { subject } = ctx;
  const consumedNote = "The one-time authorization was consumed; add a new entry before trying again.";
  const want = flow.mode1;
  const mode1Before = await frame.evaluate(setCardErDraftMode1, want).catch(() => []);
  if (mode1Before.length !== 1 || mode1Before[0] !== want) {
    audit({ action: "refusal", code: "DRAFT_MODE_NOT_SET", field: "mode1", value: JSON.stringify(mode1Before), ok: false });
    return textResult({
      error: true,
      code: "DRAFT_MODE_NOT_SET",
      message: `mode1 could not be set to '${want}' (found ${mode1Before.length} mode1 element(s): ${JSON.stringify(mode1Before)}), so Check_Form_Request was not run. Nothing was filed. ${consumedNote}`,
      mode1: mode1Before
    });
  }
  const popupState = {
    aborted: false,
    submitAttempted: false,
    submitted: false,
    subjectFixed: null,
    refusals: [],
    modeNotDraft: null,
    error: null
  };
  const dialogs = /* @__PURE__ */ new Map();
  const watchDialogs = (p) => {
    if (!p || dialogs.has(p)) return;
    const msgs = [];
    dialogs.set(p, msgs);
    p.on?.("dialog", (d) => {
      msgs.push(String(d.message?.() ?? ""));
      Promise.resolve(d.dismiss?.()).catch(() => {
      });
    });
  };
  const context = typeof page.context === "function" ? page.context() : null;
  context?.on?.("page", watchDialogs);
  const popupWait = page.waitForEvent("popup", { timeout: 25e3 }).catch(() => {
    popupState.aborted = true;
    return null;
  });
  const handlePopup = async (pop) => {
    watchDialogs(pop);
    const close = () => pop.close().catch(() => {
    });
    try {
      await pop.waitForLoadState("networkidle", { timeout: 15e3 });
      await pop.waitForTimeout(1500);
      if (popupState.aborted) return;
      if (!/budget_check_er/i.test(String(pop.url()))) {
        popupState.aborted = true;
        popupState.refusals = [`unexpected popup ${String(pop.url())}`];
        await close();
        return;
      }
      const body = await pop.evaluate(() => document.body ? document.body.innerText : "");
      const found = [...dialogs.get(pop) ?? [], ...budgetPopupRefusals(body)];
      if (found.length > 0) {
        popupState.refusals = found;
        return await close();
      }
      const current = await frame.evaluate(() => {
        const el = document.querySelector('input[name="subject"]');
        return el ? el.value : "";
      });
      const fixed = normalizeCardSubject(current);
      if (fixed !== current) {
        await frame.evaluate((v) => {
          const el = document.querySelector('input[name="subject"]');
          if (el) el.value = v;
        }, fixed);
        popupState.subjectFixed = fixed;
      }
      const late2 = dialogs.get(pop) ?? [];
      if (late2.length > 0) {
        popupState.refusals = [...late2];
        return await close();
      }
      const mode1Now = await frame.evaluate(readCardErMode1).catch(() => []);
      if (mode1Now.length !== 1 || mode1Now[0] !== want) {
        popupState.modeNotDraft = mode1Now;
        return await close();
      }
      if (popupState.aborted) return;
      popupState.submitAttempted = true;
      await pop.evaluate("submit_form()");
      popupState.submitted = true;
      await pop.waitForTimeout(4e3);
    } catch (err) {
      popupState.error = err instanceof Error ? err.message : String(err);
    }
  };
  try {
    let run;
    try {
      await frame.evaluate(installCardErStubs, false);
      run = await frame.evaluate(flow.runner);
    } catch (err) {
      popupState.aborted = true;
      return textResult({
        error: true,
        code: "SUBMIT_FAILED",
        message: `card ER save (mode1='${want}') trigger failed: ${err instanceof Error ? err.message : String(err)}. submit_form() was not called. If the page got as far as opening its budget popup, check document lists for "${subject}" before retrying. ${consumedNote}`
      });
    }
    if (run.alerts.length > 0 || run.pageError || !run.pressed) {
      popupState.aborted = true;
      return textResult({
        error: true,
        code: run.alerts.length > 0 ? "SUBMIT_REJECTED" : "SUBMIT_FAILED",
        message: (run.alerts.length > 0 ? `The form refused the save: ${run.alerts.join(" / ")}. submit_form() was not called; nothing was filed.` : `The form did not reach its Evidence Check confirmation${run.pageError ? ` (${run.pageError})` : ""}. submit_form() was not called; nothing was filed.`) + ` ${consumedNote}`,
        validation_alerts: run.alerts,
        native_confirms: run.confirms,
        confirm_buttons: run.confirmButtons
      });
    }
    const pop = await popupWait;
    if (pop && !popupState.aborted) await handlePopup(pop);
  } finally {
    popupState.aborted = true;
    context?.off?.("page", watchDialogs);
  }
  if (popupState.refusals.length > 0) {
    audit({ action: "refusal", code: "BUDGET_CHECK_REFUSED", field: "card_expense_rd", ok: false });
    return textResult({
      error: true,
      code: "BUDGET_CHECK_REFUSED",
      message: `The budget check refused the save: ${popupState.refusals.join(" / ")}. submit_form() was not called and the popup was closed. Nothing was filed. ${consumedNote}`,
      budget_check_messages: popupState.refusals
    });
  }
  if (popupState.modeNotDraft) {
    audit({ action: "refusal", code: "DRAFT_MODE_NOT_SET", field: "mode1", value: JSON.stringify(popupState.modeNotDraft), ok: false });
    return textResult({
      error: true,
      code: "DRAFT_MODE_NOT_SET",
      message: `Right before submit_form(), the form's mode1 was ${JSON.stringify(popupState.modeNotDraft)}, not exactly ['${want}'] - the page changed it after it was set. The popup was closed and submit_form() was not called. Nothing was filed. ${consumedNote}`,
      mode1: popupState.modeNotDraft
    });
  }
  if (!popupState.submitAttempted) {
    return textResult({
      error: true,
      code: "SUBMIT_FAILED",
      message: `The budget_check_er popup ${popupState.error ? `failed (${popupState.error})` : "never appeared"}, so this tool did not call submit_form(). The page ran its own flow up to that popup - check document lists for "${subject}" before retrying. ${consumedNote}`
    });
  }
  await page.waitForTimeout(2e3);
  try {
    await page.waitForLoadState("networkidle", { timeout: 1e4 });
  } catch {
  }
  if (flow.finish) return await flow.finish(popupState.subjectFixed ?? subject);
  const finalUrl = frame.url && typeof frame.url === "function" ? frame.url() : page.url();
  const m = finalUrl.match(/[?&]doc_id=(\d+)/) || String(page.url?.() ?? "").match(/[?&]doc_id=(\d+)/);
  const docId = m ? m[1] : null;
  return await finishCardErDraftSave(page, frame, config, { ...ctx, subject: popupState.subjectFixed ?? subject, docId, finalUrl });
}
async function finishCardErDraftSave(page, frame, config, args) {
  const { docId, subject, finalUrl, effectiveBudgetCode, attachResult, fileCount } = args;
  const base = {
    formType: "card_expense_rd",
    subject,
    budgetCode: effectiveBudgetCode,
    finalUrl,
    attached: attachResult.attached,
    skipped_attachments: attachResult.skipped
  };
  if (!docId) {
    audit({ action: "draft_save", docId: null, mode: "draft", ok: false, code: "DRAFT_NOT_CONFIRMED" });
    return textResult({
      error: true,
      code: "DRAFT_NOT_CONFIRMED",
      message: `submit_form() ran but no doc_id could be read from ${finalUrl}. The document may have been filed for approval - check document lists and document_view for "${subject}" before retrying. Do not retry blind.`,
      ...base
    });
  }
  const origin = new URL(config.baseUrl).origin;
  const viewUrl = `${origin}/Document/document_view.php?doc_id=${docId}&approve_type=AppFrm-021`;
  const cacheDir3 = path4.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp", "card-er-location", docId);
  try {
    let viewText = "";
    try {
      await frame.goto(viewUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
      viewText = String(await frame.evaluate(() => document.body ? document.body.innerText : "") ?? "");
    } catch {
    }
    try {
      fs7.mkdirSync(cacheDir3, { recursive: true, mode: 448 });
      fs7.writeFileSync(path4.join(cacheDir3, "document_view.rawtext.txt"), viewText, "utf8");
    } catch {
    }
    const markers = detectSubmittedOnDocumentView(viewText);
    if (markers.length > 0) {
      audit({ action: "refusal", code: "SUBMITTED_NOT_DRAFT", docId, mode: "draft", ok: false });
      return textResult({
        error: true,
        code: "SUBMITTED_NOT_DRAFT",
        docId,
        message: `doc_id ${docId} was FILED FOR APPROVAL, not saved as a draft: document_view shows ${markers.join(" and ")}. mode1='draft' did not keep it a draft. The tool did not retry and did not repossess it - the person decides whether to use [Document Repossess] on ${viewUrl} before an approver acts.`,
        submitted_markers: markers,
        document_view: viewUrl,
        cached_at: cacheDir3,
        ...base
      });
    }
    if (!viewText.trim()) {
      audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "DRAFT_NOT_CONFIRMED" });
      return textResult({
        error: true,
        code: "DRAFT_NOT_CONFIRMED",
        docId,
        message: `submit_form() ran for doc_id ${docId} but its document_view could not be read. It may have been filed for approval - check ${viewUrl} before retrying.`,
        document_view: viewUrl,
        cached_at: cacheDir3,
        ...base
      });
    }
    const foundIn = [];
    const unreadable = [];
    for (const type of ["drafts", "myapprove"]) {
      try {
        await page.goto(`${origin}/Document/document_list.php?type=${type}`, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
        await page.waitForTimeout(1e3);
        if (listHasDoc(String(await page.content()), docId)) foundIn.push(type);
      } catch {
        unreadable.push(type);
      }
    }
    if (foundIn.length > 0) {
      audit({ action: "draft_save", docId, mode: "draft", confirmed: true, ok: true, code: "DRAFT_SAVED" });
      return textResult({
        error: false,
        data: {
          ...base,
          success: true,
          outcome: "DRAFT_SAVED",
          docId,
          found_in: foundIn,
          document_view: viewUrl,
          cached_at: cacheDir3,
          message: `doc_id ${docId} saved, not filed: document_view shows no submitted marker, and it is listed in ${foundIn.map((t) => `document_list.php?type=${t}`).join(" and ")} (${attachResult.attached}/${fileCount} files attached).`
        }
      });
    }
    audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "DRAFT_NOT_CONFIRMED" });
    return textResult({
      error: true,
      code: "DRAFT_NOT_CONFIRMED",
      docId,
      message: `submit_form() ran for doc_id ${docId}; document_view shows no submitted marker, but the doc is not on the first page of Drafts or the drafter's-turn list (type=myapprove)${unreadable.length ? ` (unreadable: ${unreadable.join(", ")})` : ""}. It may have been filed - check ${viewUrl} before retrying.`,
      document_view: viewUrl,
      cached_at: cacheDir3,
      ...base
    });
  } catch (err) {
    return textResult({
      error: true,
      code: "DRAFT_NOT_CONFIRMED",
      docId,
      message: `submit_form() ran for doc_id ${docId}, but checking where it landed failed: ${err instanceof Error ? err.message : String(err)}. It may have been filed for approval - check ${viewUrl} before retrying.`,
      document_view: viewUrl,
      ...base
    });
  }
}
async function submitTravelSettlement(page, frame, sessionManager, config, params, mode) {
  const purpose = params.purpose || "Business travel";
  const subject = params.title || `[Settlement] ${purpose}`;
  const approvedDocRef = params.approved_doc_ref || params.sel_travel || "";
  if (!approvedDocRef) {
    throw new Error(
      "PARENT_DOC_REQUIRED: travel_settlement needs the approved travel request it settles. Pass approved_doc_ref. Without it the form exposes no date, purpose or budget fields and the submission is rejected with no message."
    );
  }
  let autoPopulated = false;
  if (approvedDocRef) {
    await frame.evaluate(
      (docRef) => {
        const selTravel = document.querySelector('input[name="sel_travel"]');
        if (selTravel) {
          selTravel.value = docRef;
          selTravel.dispatchEvent(new Event("change", { bubbles: true }));
        }
      },
      approvedDocRef
    );
    const deadline = Date.now() + 8e3;
    while (Date.now() < deadline) {
      autoPopulated = await frame.evaluate(() => {
        const startDate2 = document.querySelector('input[name="start_date"]');
        const province = document.querySelector('select[name="province"]');
        return !!(startDate2 && startDate2.value && startDate2.value !== "" || province && province.value && province.value !== "" && province.value !== "0");
      });
      if (autoPopulated) break;
      await page.waitForTimeout(400);
    }
  }
  if (!autoPopulated) {
    audit({ action: "refusal", field: "sel_travel", code: "PARENT_DOC_NOT_ACCEPTED", ok: false });
    throw new Error(
      `PARENT_DOC_NOT_ACCEPTED: the form did not load anything from '${approvedDocRef}'. Check the document number of the approved travel request, or pick it through the form's [Search] button. Refusing to submit a settlement whose parent is unverified.`
    );
  }
  const startDate = params.start_date || todayStr();
  const endDate = params.end_date || startDate;
  const nights = Math.max(0, Math.round((new Date(endDate).getTime() - new Date(startDate).getTime()) / 864e5));
  const dailyExpense = params.daily_expense || (nights === 0 ? 2e4 : 3e4 * nights);
  const transportFee = params.transport_fee || 0;
  const accommodationFee = params.accommodation || 0;
  const foodExpense = params.food_expense || 0;
  const postSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    budget_control_no: { type: "hidden", dom_name: "budget_control_no" },
    daily_fee_total: { type: "text", dom_name: "daily_fee_total" },
    ocar_pay: { type: "text", dom_name: "ocar_pay" },
    accommodation_fee_total: { type: "text", dom_name: "accommodation_fee_total" },
    food_fee_total: { type: "text", dom_name: "food_fee_total" }
  };
  await genericFillForm(frame, postSchema, {
    subject,
    budget_control_no: params.budget_control_no || "",
    daily_fee_total: String(dailyExpense),
    ocar_pay: transportFee ? String(transportFee) : "",
    accommodation_fee_total: accommodationFee ? String(accommodationFee) : "",
    food_fee_total: foodExpense ? String(foodExpense) : ""
  });
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path, slotSelector(params.attachment_slot));
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  if (params.dry_run) return textResult({ error: false, data: await buildDryRunPreview(page, frame, config, "travel_settlement") });
  const settlementRuleRefusal = await checkFieldRulesAgainstForm(frame, "travel_settlement");
  if (settlementRuleRefusal) return textResult({ error: true, ...settlementRuleRefusal });
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  const warnings = [];
  if (params.transport_mode?.includes("Own Vehicle") && !params.attachment_path) {
    warnings.push("Own vehicle travel requires \uAC70\uB9AC.pdf (Naver Maps screenshot) attachment.");
  }
  if (params.toll_fee && params.toll_fee > 0 && !params.attachment_path) {
    warnings.push("Toll fee claimed requires \uD558\uC774\uD328\uC2A4 \uC601\uC218\uC99D attachment.");
  }
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "travel_settlement",
      subject,
      autoPopulated,
      message: docId ? `Travel settlement ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Travel settlement ${mode} completed`,
      warning: warnings.length > 0 ? warnings.join(" | ") : void 0
    }
  });
}
async function submitLeaveReturn(page, frame, sessionManager, config, params, mode) {
  const originalDoc = params.original_leave_doc || "";
  if (!originalDoc) {
    return textResult({ error: true, code: "MISSING_FIELD", message: "original_leave_doc is required (e.g. ARL-260121-02)" });
  }
  const periodStart = params.start_date || params.period_start || todayStr();
  const periodEnd = params.end_date || params.period_end || periodStart;
  const returnDays = params.return_days ?? 1;
  const returnHours = params.return_hours ?? 0;
  const description = params.description || params.reason || "Leave return";
  const leaveType = params.leave_type || "annual";
  const leaveCode = LEAVE_TYPES[leaveType] || "01";
  let returnLabel = "";
  if (returnDays > 0 && returnHours > 0) {
    returnLabel = `${returnDays}day(s)/${returnHours}hour(s)`;
  } else if (returnDays > 0) {
    returnLabel = `${returnDays}day(s)`;
  } else {
    returnLabel = `${returnHours}hour(s)`;
  }
  const subject = params.title || `Leave return ${returnLabel} ${originalDoc}`;
  const fieldSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    original_leave_doc: { type: "text", dom_name: "original_leave_doc", required: true },
    leave_type: { type: "select", dom_name: "leave_kind[]", required: false },
    period_start: { type: "date", dom_name: "begin_date", required: true },
    period_end: { type: "date", dom_name: "end_date", required: true },
    return_days: { type: "integer", dom_name: "return_days", required: false },
    return_hours: { type: "integer", dom_name: "return_hours", required: false },
    description: { type: "textarea", dom_name: "description", required: false }
  };
  const userData = {
    subject,
    original_leave_doc: originalDoc,
    leave_type: leaveCode,
    period_start: periodStart,
    period_end: periodEnd,
    return_days: String(returnDays),
    return_hours: String(returnHours),
    description
  };
  const hooks = [
    {
      trigger: "post_fill",
      fn: async (f) => {
        await setFieldValue(f, 'textarea[name="contents1"]', description);
      }
    }
  ];
  await genericFillForm(frame, fieldSchema, userData, hooks);
  await page.waitForTimeout(1e3);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "leave_return",
      subject,
      message: docId ? `Leave return ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Leave return ${mode} completed`
    }
  });
}
async function submitSeminar(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const subject = params.title || params.subject || "";
  if (!subject) {
    return textResult({ error: true, code: "MISSING_FIELD", message: "title is required (title of the seminar/event/publication)" });
  }
  const requester = params.attendees || userInfo.name;
  const disclosurePurpose = params.disclosure_purpose || params.purpose || "";
  const disclosureDate = params.disclosure_date || params.start_date || todayStr();
  const materialDesc = params.material_description || "";
  const conferenceOrJournal = params.conference_or_journal || params.organization || "";
  const fieldSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    requester: { type: "text", dom_name: "requester", required: false },
    disclosure_purpose: { type: "textarea", dom_name: "disclosure_purpose", required: false },
    disclosure_date: { type: "date", dom_name: "disclosure_date", required: false },
    material_description: { type: "text", dom_name: "material_description", required: false },
    conference_or_journal: { type: "text", dom_name: "conference_or_journal", required: false }
  };
  const userData = {
    subject,
    requester,
    disclosure_purpose: disclosurePurpose,
    disclosure_date: disclosureDate,
    material_description: materialDesc,
    conference_or_journal: conferenceOrJournal
  };
  const hooks = [
    {
      trigger: "post_fill",
      fn: async (f) => {
        await setFieldValue(f, '.validate[name="requester"]', requester);
        await setFieldValue(f, '.validate[name="purpose_field"]', disclosurePurpose);
        await setFieldValue(f, '.validate[name="disclosure_date"]', disclosureDate);
        await setFieldValue(f, '.validate[name="material_description"]', materialDesc);
        await setFieldValue(f, '.validate[name="conference_or_journal"]', conferenceOrJournal);
      }
    },
    {
      trigger: "evaluate",
      fn: async (f) => {
        const radioValues = {
          patent_filed: params.patent_filed || "",
          patent_planned: params.patent_planned || "",
          material_published: params.material_published || "N",
          collaborator_approval: params.collaborator_approval || "Y",
          contains_confidential: params.contains_confidential || "N"
        };
        await f.evaluate(
          (rv) => {
            const radioMap = [
              ["patent_filed", "Q1"],
              ["patent_planned", "Q2"],
              ["material_published", "Q3"],
              ["collaborator_approval", "Q4"],
              ["contains_confidential", "Q5"]
            ];
            for (const [paramKey, qName] of radioMap) {
              const val = rv[paramKey];
              if (!val) continue;
              const selectors = [
                `input[name="${qName}"][value="${val}"]`,
                `input[name="radio_${qName}"][value="${val}"]`,
                `input[name="chk_${qName}"][value="${val}"]`
              ];
              for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                  el.checked = true;
                  el.dispatchEvent(new Event("change", { bubbles: true }));
                  break;
                }
              }
            }
          },
          radioValues
        );
        await f.evaluate(() => {
          const chk = document.querySelector('input[name="chk410306"]') || document.querySelector('input[type="checkbox"][name*="chk"]');
          if (chk && !chk.checked) {
            chk.checked = true;
            chk.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      }
    }
  ];
  await genericFillForm(frame, fieldSchema, userData, hooks);
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "seminar",
      subject,
      message: docId ? `Seminar disclosure ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Seminar disclosure ${mode} completed`,
      warning: !params.attachment_path ? "No attachment provided. Seminar disclosure forms typically require presentation materials." : void 0
    }
  });
}
async function submitOverseasTravel(page, frame, sessionManager, config, params, mode) {
  const userInfo = sessionManager.getUserInfo();
  const conferenceName = params.conference_name || params.organization || "";
  const subject = params.title || `[Settlement] ${conferenceName || "Overseas Business Travel"}`;
  const country = params.country || "";
  const purpose = params.purpose || `Attend ${conferenceName}`;
  const travelStart = params.travel_start || params.start_date || todayStr();
  const travelEnd = params.travel_end || params.end_date || travelStart;
  const paymentDate = params.payment_date || todayStr();
  const budgetControlNo = params.budget_control_no || "";
  const corpCardNo = params.corp_card_no || process.env.IPK_CORP_CARD_NO || "";
  const payrollId = process.env.IPK_PAYROLL_ID || "";
  const travelerStr = payrollId ? `${userInfo.name}(${payrollId})` : userInfo.name;
  const fieldSchema = {
    subject: { type: "text", dom_name: "subject", required: true },
    traveler: { type: "text", dom_name: "traveler", required: false },
    budget_control_no: { type: "text", dom_name: "budget_control_no", required: false },
    country: { type: "text", dom_name: "country", required: true },
    conference_name: { type: "text", dom_name: "conference_name", required: false },
    purpose: { type: "textarea", dom_name: "purpose", required: true },
    travel_start: { type: "date", dom_name: "travel_start", required: true },
    travel_end: { type: "date", dom_name: "travel_end", required: true },
    payment_date: { type: "date", dom_name: "payment_date", required: false },
    corp_card_no: { type: "text", dom_name: "corp_card_no", required: false },
    // Expense fields
    transport_fee_total: { type: "number", dom_name: "transport_fee_total", required: false },
    transport_fee_card: { type: "number", dom_name: "transport_fee_card", required: false },
    daily_expense_total: { type: "number", dom_name: "daily_expense_total", required: false },
    daily_expense_cash: { type: "number", dom_name: "daily_expense_cash", required: false },
    accommodation_total: { type: "number", dom_name: "accommodation_total", required: false },
    accommodation_card: { type: "number", dom_name: "accommodation_card", required: false },
    food_expense_total: { type: "number", dom_name: "food_expense_total", required: false },
    food_expense_cash: { type: "number", dom_name: "food_expense_cash", required: false },
    settle_amount: { type: "number", dom_name: "settle_amount", required: false },
    reimbursement: { type: "number", dom_name: "reimbursement", required: false },
    business_materials: { type: "text", dom_name: "business_materials", required: false }
  };
  const userData = {
    subject,
    traveler: travelerStr,
    budget_control_no: budgetControlNo,
    country,
    conference_name: conferenceName,
    purpose,
    travel_start: travelStart,
    travel_end: travelEnd,
    payment_date: paymentDate,
    corp_card_no: corpCardNo,
    transport_fee_total: params.transport_fee_budget,
    transport_fee_card: params.transport_fee_corp_card,
    daily_expense_total: params.daily_expense_budget,
    daily_expense_cash: params.daily_expense_cash,
    accommodation_total: params.accommodation_budget,
    accommodation_card: params.accommodation_corp_card,
    food_expense_total: params.food_expense_budget,
    food_expense_cash: params.food_expense_cash,
    settle_amount: params.settle_amount,
    reimbursement: params.reimbursement,
    business_materials: params.material_description
  };
  const hooks = [
    {
      trigger: "post_fill",
      fn: async (f) => {
        await setFieldValue(f, '.validate[name="traveler"]', travelerStr);
        if (budgetControlNo) await setFieldValue(f, '.validate[name="budget_control_no"]', budgetControlNo);
        await setFieldValue(f, '.validate[name="conference_name"]', conferenceName);
        await setFieldValue(f, '.validate[name="purpose_field"]', purpose);
        if (corpCardNo) await setFieldValue(f, '.validate[name="corp_card_no"]', corpCardNo);
        const expenseFields = [
          ["transport_fee_total", params.transport_fee_budget],
          ["transport_fee_card", params.transport_fee_corp_card],
          ["daily_expense_total", params.daily_expense_budget],
          ["daily_expense_cash", params.daily_expense_cash],
          ["accommodation_total", params.accommodation_budget],
          ["accommodation_card", params.accommodation_corp_card],
          ["food_expense_total", params.food_expense_budget],
          ["food_expense_cash", params.food_expense_cash],
          ["settle_amount", params.settle_amount],
          ["reimbursement", params.reimbursement]
        ];
        for (const [fieldName, value] of expenseFields) {
          if (value !== void 0 && value !== null) {
            await setFieldValue(f, `.validate[name="${fieldName}"]`, String(value));
          }
        }
        if (params.material_description) {
          await setFieldValue(f, '.validate[name="business_materials"]', params.material_description);
        }
      }
    },
    {
      trigger: "evaluate",
      fn: async (f) => {
        await f.evaluate(() => {
          const radioSelectors = [
            ['input[name="travel_with_invitation"][value="No"]', 'input[name="invitation"][value="No"]'],
            ['input[name="car_rent"][value="No"]', 'input[name="rent_car"][value="No"]']
          ];
          for (const selectors of radioSelectors) {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              if (el) {
                el.checked = true;
                el.dispatchEvent(new Event("change", { bubbles: true }));
                break;
              }
            }
          }
        });
        if (params.schedule_rows && Array.isArray(params.schedule_rows)) {
          await f.evaluate(
            (rows) => {
              for (let i = 0; i < rows.length; i++) {
                const row = rows[i];
                const fromEl = document.querySelector(`input[name="schedule_from[${i}]"]`);
                const toEl = document.querySelector(`input[name="schedule_to[${i}]"]`);
                const schedEl = document.querySelector(`input[name="schedule_desc[${i}]"]`) || document.querySelector(`textarea[name="schedule_desc[${i}]"]`);
                const transEl = document.querySelector(`input[name="schedule_transport[${i}]"]`);
                if (fromEl) fromEl.value = row.from;
                if (toEl) toEl.value = row.to;
                if (schedEl) schedEl.value = row.schedule;
                if (transEl) transEl.value = row.transportation;
              }
            },
            params.schedule_rows
          );
        }
      }
    }
  ];
  await genericFillForm(frame, fieldSchema, userData, hooks);
  if (params.budget_code) {
    await setSelectValue(frame, 'select[name="budget_type"]', "01");
    await page.waitForTimeout(2e3);
    await setSelectValue(frame, 'select[name="budget_code"]', params.budget_code);
    await page.waitForTimeout(1500);
  }
  if (params.attachment_path) {
    await attachFile(frame, params.attachment_path, slotSelector(params.attachment_slot));
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType: "overseas_travel",
      subject,
      message: docId ? `Overseas travel settlement ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `Overseas travel settlement ${mode} completed`
    }
  });
}
async function submitGeneric(page, frame, sessionManager, config, params, mode, formType, templateSchema) {
  const userData = {};
  for (const fieldKey of Object.keys(templateSchema)) {
    if (params[fieldKey] !== void 0) {
      userData[fieldKey] = params[fieldKey];
    }
  }
  if (templateSchema.subject && !userData.subject && params.title) {
    userData.subject = params.title;
  }
  await genericFillForm(frame, templateSchema, userData);
  if (params.attachment_path) {
    const validationError = validateAttachmentPath(params.attachment_path);
    if (validationError) {
      return textResult({ error: true, code: "INVALID_ATTACHMENT", message: validationError });
    }
    await attachFile(frame, params.attachment_path);
    await page.waitForTimeout(1e3);
  }
  await page.waitForTimeout(1e3);
  await setFormMode(frame, mode);
  const docId = await submitForm(page, frame, "check_form_request");
  return textResult({
    error: false,
    data: {
      success: true,
      docId,
      mode,
      formType,
      message: docId ? `${formType} ${mode === "draft" ? "draft saved" : "submitted"} (doc_id: ${docId})` : `${formType} ${mode} completed`,
      note: "Filled via generic template handler. Verify form completeness via screenshot."
    }
  });
}
function todayStr() {
  return (/* @__PURE__ */ new Date()).toISOString().split("T")[0];
}
function tomorrow() {
  const d = /* @__PURE__ */ new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().split("T")[0];
}

// src/tools/ipk-fetch.ts
var ipkFetchApprovalsSchema = {
  status: external_exports.enum(["all", "pending", "approved", "rejected", "draft"]).default("all").describe("Filter by approval status"),
  limit: external_exports.number().default(20).describe("Max number of items to return")
};
var ipkFetchApprovalsDescription = "Fetch approval/document list from IPK groupware. Returns structured JSON with document IDs, titles, status, and dates.";
var STATUS_URL_MAP = {
  pending: "progress",
  approved: "approved",
  rejected: "rejected",
  draft: "draft"
};
var ALL_STATUS_TYPES = ["approved", "rejected", "draft", "progress"];
var DEDUP_PRIORITY = {
  approved: 3,
  rejected: 2,
  draft: 1,
  progress: 0
};
function statusToPriority(status) {
  const s = status.toLowerCase();
  for (const [key, pri] of Object.entries(DEDUP_PRIORITY)) {
    if (s.includes(key)) return pri;
  }
  return -1;
}
async function fetchByType(sessionManager, config, urlType, maxItems) {
  const page = sessionManager.getPage();
  const origin = new URL(config.baseUrl).origin;
  await page.goto(
    `${origin}/Document/document_list.php?type=${urlType}`,
    { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs }
  );
  const results = await page.evaluate(
    (args) => {
      const links = document.querySelectorAll("a[href*='doc_id=']");
      const out = [];
      const seen = /* @__PURE__ */ new Set();
      for (const link of links) {
        if (out.length >= args.maxItems) break;
        const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
        if (!m) continue;
        const docId = m[1];
        if (seen.has(docId)) continue;
        seen.add(docId);
        const row = link.closest("tr");
        if (!row) continue;
        const cells = row.querySelectorAll("td");
        if (cells.length < 4) continue;
        const title = link.textContent?.trim() || "";
        const author = cells[3]?.textContent?.trim() || "";
        const status = cells[4]?.textContent?.trim() || args.urlType;
        const date = cells[5]?.textContent?.trim() || cells[cells.length - 1]?.textContent?.trim() || "";
        out.push({ docId, title, status, date, author, formType: "unknown" });
      }
      return out;
    },
    { maxItems, urlType }
  );
  await page.goto(config.baseUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  return results;
}
async function handleIpkFetchApprovals(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const limit = params.limit || 20;
  const statusParam = params.status || "all";
  try {
    let rawItems = [];
    if (statusParam === "all") {
      for (const urlType of ALL_STATUS_TYPES) {
        const items = await fetchByType(sessionManager, config, urlType, limit);
        rawItems.push(...items);
      }
    } else {
      const urlType = STATUS_URL_MAP[statusParam] ?? statusParam;
      rawItems = await fetchByType(sessionManager, config, urlType, limit);
    }
    const dedupMap = /* @__PURE__ */ new Map();
    for (const item of rawItems) {
      const pri = statusToPriority(item.status);
      const existing = dedupMap.get(item.docId);
      if (!existing || pri > existing._pri) {
        dedupMap.set(item.docId, { ...item, _pri: pri });
      }
    }
    const deduped = [...dedupMap.values()].sort((a, b) => b._pri - a._pri).slice(0, limit).map(({ _pri: _p, ...item }) => item);
    return textResult({
      error: false,
      data: {
        count: deduped.length,
        totalFound: rawItems.length,
        filter: { status: statusParam },
        items: deduped
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "FETCH_ERROR", message: msg });
  }
}

// src/tools/ipk-navigate.ts
var ipkNavigateSchema = {
  url: external_exports.string().describe(
    "URL to navigate to. Can be a full URL or a path relative to the groupware base URL (e.g. '/Document/document_list.php')"
  ),
  wait_for: external_exports.enum(["networkidle", "load", "domcontentloaded"]).default("load").describe("Wait condition after navigation")
};
var ipkNavigateDescription = "Navigate within the IPK groupware main_menu iframe. Accepts full URLs or relative paths. Content is rendered inside the groupware iframe structure.";
async function handleIpkNavigate(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const page = sessionManager.getPage();
  try {
    const frame = await navigateInFrame(page, params.url, config);
    if (!frame) {
      return textResult({
        error: true,
        code: "NAVIGATION_FAILED",
        message: "Failed to navigate. main_menu frame not found."
      });
    }
    let frameUrl = frame.url();
    if (!frameUrl.includes("gw.ip-korea.org")) {
      try {
        frameUrl = await frame.evaluate(() => location.href);
      } catch (e) {
        console.warn("[ipk_navigate] frame.evaluate fallback failed:", e);
      }
    }
    const title = await frame.title();
    return textResult({
      error: false,
      data: {
        url: frameUrl,
        title
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "NAVIGATION_ERROR", message: msg });
  }
}

// src/security/sanitizer.ts
function isolateContent(content) {
  return `[CONTENT_START]
${content}
[CONTENT_END]`;
}
function sanitizeWebContent(text) {
  const patterns = [
    // Direct instruction injection
    /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/gi,
    // System prompt extraction
    /\b(show|reveal|print|output|display)\s+(your|the|system)\s+(prompt|instructions?|rules?)/gi,
    // Role manipulation
    /\byou\s+are\s+now\s+(a|an)\s+/gi,
    // Tool abuse
    /\b(execute|run|call)\s+(tool|function|command)\s/gi
  ];
  let sanitized = text;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }
  return sanitized;
}
function truncateContent(text, maxChars = 2e3) {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }
  return {
    text: text.slice(0, maxChars) + "\n... [TRUNCATED]",
    truncated: true
  };
}

// src/security/masking.ts
function maskKoreanName(name) {
  if (!name || name.length < 2) return name;
  if (/^[\uAC00-\uD7AF]{2,4}$/.test(name)) {
    if (name.length === 2) return name[0] + "*";
    if (name.length === 3) return name[0] + "*" + name[2];
    return name[0] + "*".repeat(name.length - 2) + name[name.length - 1];
  }
  const parts = name.split(/\s+/);
  if (parts.length >= 2) {
    return parts[0][0] + ". " + parts[parts.length - 1];
  }
  return name[0] + "*".repeat(Math.max(1, name.length - 2)) + name[name.length - 1];
}
function maskPhone(phone) {
  if (!phone) return phone;
  return phone.replace(
    /(\d{2,3})[-.]?(\d{3,4})[-.]?(\d{4})/,
    "$1-****-$3"
  );
}
function maskEmail(email) {
  if (!email || !email.includes("@")) return email;
  const [local, domain] = email.split("@");
  if (local.length <= 1) return email;
  return local[0] + "***@" + domain;
}
function maskPiiInText(text) {
  let result = text.replace(
    /\d{2,3}[-.]?\d{3,4}[-.]?\d{4}/g,
    (match) => maskPhone(match)
  );
  result = result.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (match) => maskEmail(match)
  );
  result = result.replace(
    /(?<=[\s,;:(]|^)([\uAC00-\uD7AF]{2,4})(?=[\s,;:)]|$)/g,
    (match) => maskKoreanName(match)
  );
  return result;
}

// src/tools/ipk-content.ts
var ipkGetContentSchema = {
  max_chars: external_exports.number().default(2e3).describe("Maximum characters to return (default 2000)"),
  include_forms: external_exports.boolean().default(false).describe("Include form field names and values"),
  frame: external_exports.enum(["main_menu", "page"]).default("main_menu").describe("Which frame to extract content from")
};
var ipkGetContentDescription = "Extract text content from the current page or main_menu iframe in IPK groupware. Returns structured text, sanitized and truncated. Use include_forms=true to see form fields.";
async function handleIpkGetContent(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const page = sessionManager.getPage();
  const maxChars = params.max_chars || 2e3;
  try {
    const target = params.frame === "page" ? page : getMainFrame(page);
    if (!target) {
      return textResult({
        error: true,
        code: "FRAME_NOT_FOUND",
        message: "main_menu frame not found. Navigate first."
      });
    }
    const rawContent = await target.evaluate(
      (opts) => {
        let text = document.body?.innerText || "";
        if (opts.includeForms) {
          const formFields = [];
          const inputs = document.querySelectorAll("input, select, textarea");
          inputs.forEach((el) => {
            const name = el.getAttribute("name");
            if (!name) return;
            const type = el.tagName.toLowerCase();
            const value = el.value || "";
            formFields.push(`[${type}] ${name} = ${value}`);
          });
          if (formFields.length > 0) {
            text += "\n\n--- Form Fields ---\n" + formFields.join("\n");
          }
        }
        return {
          text,
          url: window.location.href,
          title: document.title
        };
      },
      { includeForms: params.include_forms || false }
    );
    let processedText = sanitizeWebContent(rawContent.text);
    processedText = maskPiiInText(processedText);
    const { text: truncatedText, truncated } = truncateContent(processedText, maxChars);
    const content = {
      url: rawContent.url,
      title: rawContent.title,
      text: truncatedText,
      truncated
    };
    return textResult({
      error: false,
      data: {
        url: content.url,
        title: content.title,
        truncated: content.truncated,
        content: isolateContent(content.text)
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "CONTENT_ERROR", message: msg });
  }
}

// src/tools/screenshot.ts
import * as fs8 from "fs";
import * as path5 from "path";
var screenshotSchema = {
  filename: external_exports.string().optional().describe("Custom filename (without path). Default: auto-generated timestamp."),
  full_page: external_exports.boolean().default(false).describe("Capture full page (true) or viewport only (false)")
};
var screenshotDescription = "Take a screenshot of the current browser state. Returns the file path only (not image data) to save tokens. Screenshots are automatically deleted after the configured TTL (default 60 minutes).";
async function handleScreenshot(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({ error: true, code: "NOT_LOGGED_IN", message: "Call ipk_login first" });
  }
  const page = sessionManager.getPage();
  try {
    fs8.mkdirSync(config.screenshotDir, { recursive: true, mode: 448 });
    const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const filename = params.filename || `ipk-${timestamp}.png`;
    const filepath = path5.join(config.screenshotDir, filename);
    await page.screenshot({
      path: filepath,
      fullPage: params.full_page || false
    });
    const ttlMs = config.screenshotTtlMinutes * 60 * 1e3;
    setTimeout(() => {
      try {
        if (fs8.existsSync(filepath)) {
          fs8.unlinkSync(filepath);
        }
      } catch {
      }
    }, ttlMs);
    const result = {
      path: filepath,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      ttlMinutes: config.screenshotTtlMinutes
    };
    return textResult({
      error: false,
      data: result
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "SCREENSHOT_ERROR", message: msg });
  }
}
function cleanupExpiredScreenshots(config) {
  try {
    if (!fs8.existsSync(config.screenshotDir)) return;
    const now = Date.now();
    const ttlMs = config.screenshotTtlMinutes * 60 * 1e3;
    const files = fs8.readdirSync(config.screenshotDir);
    for (const file of files) {
      if (!file.endsWith(".png")) continue;
      const filepath = path5.join(config.screenshotDir, file);
      const stat = fs8.statSync(filepath);
      if (now - stat.mtimeMs > ttlMs) {
        fs8.unlinkSync(filepath);
      }
    }
  } catch {
  }
}

// src/tools/ipk-inspect.ts
import * as fs9 from "fs";
import * as path6 from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var __filename2 = fileURLToPath2(import.meta.url);
var __dirname2 = path6.dirname(__filename2);
var ipkInspectFormSchema = {
  form_code: external_exports.string().describe("Form code to inspect, e.g. AppFrm-054"),
  compare_template: external_exports.boolean().default(true).describe("Cross-verify against form_templates JSON")
};
var ipkInspectFormDescription = "Inspect a groupware form's DOM elements and cross-verify against form templates. Use to discover actual field names, types, and options for any form.";
async function handleIpkInspectForm(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const page = sessionManager.getPage();
  const formCode = params.form_code;
  const compareTemplate = params.compare_template !== false;
  try {
    const url = `/Document/document_write.php?approve_type=${formCode}`;
    const frame = await navigateInFrame(page, url, config);
    if (!frame) {
      return textResult({
        error: true,
        code: "FRAME_NOT_FOUND",
        message: "main_menu frame not found. Ensure you are logged in and the groupware is accessible."
      });
    }
    await frame.waitForSelector("input, select, textarea", { timeout: 8e3 }).catch(() => null);
    const domElements = await frame.evaluate(() => {
      const elements = [];
      document.querySelectorAll("input, select, textarea").forEach((el) => {
        if (!el.name) return;
        const info = {
          tag: el.tagName.toLowerCase(),
          name: el.name,
          type: el.type || el.tagName.toLowerCase(),
          id: el.id || "",
          required: el.required || false
        };
        if (el.tagName === "SELECT") {
          info.options = Array.from(el.options).map((o) => ({
            value: o.value,
            text: (o.textContent || "").trim()
          }));
        }
        elements.push(info);
      });
      return elements;
    });
    const result = {
      form_code: formCode,
      dom_url: frame.url(),
      element_count: domElements.length,
      elements: domElements
    };
    if (compareTemplate) {
      const projectRoot = path6.resolve(__dirname2, "..", "..");
      const templatePath = path6.join(projectRoot, "form_templates", `${formCode}.json`);
      try {
        const raw = fs9.readFileSync(templatePath, "utf-8");
        const template = JSON.parse(raw);
        const fieldSchema = template.field_schema || {};
        const templateKeys = new Set(Object.keys(fieldSchema));
        const domNames = new Set(domElements.map((e) => e.name));
        const inTemplateNotInDom = [...templateKeys].filter((k) => !domNames.has(k));
        const inDomNotInTemplate = [...domNames].filter((k) => !templateKeys.has(k));
        const typeMismatches = [];
        for (const el of domElements) {
          if (!templateKeys.has(el.name)) continue;
          const tType = fieldSchema[el.name].type;
          const domType = el.tag === "textarea" ? "textarea" : el.tag === "select" ? "select" : el.type;
          const normalize = (t) => {
            if (t === "textarea") return "textarea";
            if (t === "select" || t === "select-one" || t === "select-multiple") return "select";
            if (t === "number" || t === "text" || t === "date" || t === "time") return t;
            return t;
          };
          const normTemplate = normalize(tType);
          const normDom = normalize(domType);
          if (normTemplate !== normDom) {
            typeMismatches.push({
              field: el.name,
              template_type: tType,
              dom_type: domType
            });
          }
        }
        result.template_comparison = {
          template_found: true,
          template_path: templatePath,
          mismatch_report: {
            in_template_not_in_dom: inTemplateNotInDom,
            in_dom_not_in_template: inDomNotInTemplate,
            type_mismatches: typeMismatches
          }
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.template_comparison = {
          template_found: false,
          template_path: templatePath,
          error: `Template not found or parse error: ${msg}`
        };
      }
    }
    return textResult({ error: false, data: result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return textResult({ error: true, code: "INSPECT_ERROR", message: msg });
  }
}

// src/tools/ipk-profile.ts
var ipkProfileInitSchema = {};
var ipkProfileInitDescription = "Read this logged-in person's own cards and budget pots off the groupware (read-only - never saves, drafts, or submits anything) and write ~/.config/ipk-browser-mcp/profile.json. Run this once per person (and again whenever a card or budget pot changes) before card/leave/travel/budget forms that have self-scope fields (card number, budget pot), so field-rules.ts has something to check those fields against instead of blocking and asking every time. Works with 0 approved documents - cards and pots come from the card list and a form's own select options, not from history. Returns masked card numbers (last 4 digits only) and a list of keys it could not derive, if any.";
var CARD_TAIL_RE = /\d{4}-\d{4}-\d{4}-\d{4}/g;
var NAME_RE = /[A-Z][a-zA-Z.'-]*(?:\s+[A-Z][a-zA-Z.'-]*)+/;
function lastMatch(re, text) {
  const all = text.match(re);
  return all && all.length > 0 ? all[all.length - 1] : null;
}
function normName(s) {
  return s.replace(/\s+/g, "").toLowerCase();
}
function idToDisplayName(id) {
  if (/\s/.test(id)) return id;
  return id.split(/[._]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" ");
}
function parseCardListRows(rows, ownerAliases) {
  const aliasSet = new Set(
    ownerAliases.filter(Boolean).flatMap((a) => [normName(a), normName(idToDisplayName(a))])
  );
  const out = [];
  for (const row of rows) {
    const number = lastMatch(CARD_TAIL_RE, row.cardCell);
    if (!number) continue;
    const ownerName = NAME_RE.exec(row.ownerCell)?.[0] ?? row.ownerCell;
    const holder_match = aliasSet.has(normName(ownerName));
    out.push({ number, kind: holder_match ? "own" : "shared", holder_match });
  }
  return out;
}
function dedupeCards(rows, source) {
  const byDigits = /* @__PURE__ */ new Map();
  for (const r of rows) {
    const digits = r.number.replace(/\D/g, "");
    const existing = byDigits.get(digits);
    if (!existing) {
      byDigits.set(digits, { number: r.number, kind: r.kind, holder_match: r.holder_match, source });
    } else if (r.kind === "own" && existing.kind !== "own") {
      byDigits.set(digits, { number: r.number, kind: "own", holder_match: true, source });
    }
  }
  return [...byDigits.values()];
}
function parseBudgetPotOptions(options, source) {
  const CODE_RE = /^[A-Za-z]{2}\d{2,4}-\d+$/;
  return options.filter((o) => CODE_RE.test(o.value)).map((o) => ({
    code: o.value,
    label: o.text?.trim() || void 0,
    fiscal_year: fiscalYearFromCode(o.value),
    source
  }));
}
function parseApprovedCardDoc(text) {
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim());
  const cardLine = lines.find((l) => /\bCard Number\b/.test(l));
  const cardNumber = cardLine ? lastMatch(/\d{4}-(?:[Xx]{4}|\d{4})-(?:[Xx]{4}|\d{4})-\d{4}/g, cardLine) : null;
  const accountLine = lines.find((l) => /\[\d{6}\]/.test(l));
  const accountCode = accountLine ? (accountLine.match(/\[(\d{6})\]/) ?? [])[1] ?? null : null;
  return { cardNumber, accountCode };
}
function ownerAliasesFor(userInfo) {
  if (!userInfo) return [];
  const envName = process.env.IPK_USER_NAME;
  return [userInfo.name, userInfo.username, idToDisplayName(userInfo.username), envName ?? "", envName ? idToDisplayName(envName) : ""];
}
async function fetchCardsFromGroupware(page, config, userInfo) {
  const origin = new URL(config.baseUrl).origin;
  await page.goto(`${origin}/Document/corporation_card_list.php`, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.waitForTimeout(1e3);
  const raw = await page.mainFrame().evaluate(() => {
    const tables = Array.from(document.querySelectorAll("table"));
    const t = tables.find((tbl) => {
      const headRow = tbl.querySelector("tr");
      const headerText = headRow ? Array.from(headRow.querySelectorAll("th,td")).map((c) => (c.textContent || "").trim()) : [];
      return headerText.includes("Owner") && headerText.includes("Card No");
    });
    if (!t) return [];
    const trs = Array.from(t.querySelectorAll("tr"));
    const headers = Array.from(trs[0].querySelectorAll("th,td")).map((c) => (c.textContent || "").trim());
    const cardIdx = headers.indexOf("Card No");
    const ownerIdx = headers.indexOf("Owner");
    const out = [];
    for (const tr of trs.slice(1)) {
      const cells = Array.from(tr.querySelectorAll("td"));
      const cardCell = (cells[cardIdx]?.textContent || "").replace(/\s+/g, " ").trim();
      const ownerCell = (cells[ownerIdx]?.textContent || "").replace(/\s+/g, " ").trim();
      if (cardCell) out.push({ cardCell, ownerCell });
    }
    return out;
  });
  const parsed = parseCardListRows(raw, ownerAliasesFor(userInfo));
  return dedupeCards(parsed, "corporation_card_list.php");
}
function bucketApprovedCards(docs, isMeeting, source) {
  const nonMeeting = docs.filter((d) => d.cardNumber && !isMeeting(d.accountCode));
  const counts = /* @__PURE__ */ new Map();
  const tally = /* @__PURE__ */ new Map();
  for (const d of nonMeeting) {
    const digits = d.cardNumber.replace(/\D/g, "");
    tally.set(digits, (tally.get(digits) ?? 0) + 1);
    if (!counts.has(digits)) counts.set(digits, d.cardNumber);
  }
  const out = [];
  for (const [digits, count2] of tally) {
    out.push({
      number: counts.get(digits),
      kind: count2 >= 2 ? "own" : "own-unconfirmed",
      holder_match: true,
      source
    });
  }
  return out;
}
async function fetchOwnCardsFromApprovedERs(page, config) {
  const origin = new URL(config.baseUrl).origin;
  const ymd2 = (d) => d.toISOString().slice(0, 10);
  const e = /* @__PURE__ */ new Date();
  const s = new Date(e.getTime() - 365 * 864e5);
  const listUrl = `${origin}/Document/document_list.php?type=approved&s_date=${ymd2(s)}&e_date=${ymd2(e)}&keyword=&writer=Y&title=Y&contents=Y&attachment=Y`;
  await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.waitForTimeout(1e3);
  const hrefs = await page.mainFrame().$$eval(
    "a[href*='doc_id=']",
    (as) => as.map((a) => a.getAttribute("href") || "").filter((h) => h.includes("approve_type=AppFrm-021"))
  );
  const docs = [];
  for (const href of hrefs.slice(0, 10)) {
    await page.goto(new URL(href, `${origin}/Document/`).href, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.body.innerText);
    docs.push(parseApprovedCardDoc(text));
  }
  return bucketApprovedCards(docs, isMeetingAccount, "AppFrm-021 approved documents");
}
async function fetchBudgetPotsFromGroupware(page, config) {
  const origin = new URL(config.baseUrl).origin;
  await page.goto(`${origin}/Document/document_write.php?approve_type=AppFrm-021`, { waitUntil: "domcontentloaded", timeout: config.navTimeoutMs });
  await page.mainFrame().waitForSelector('select[name="budget_code"]', { timeout: 8e3 }).catch(() => null);
  const options = await page.mainFrame().evaluate(() => {
    const el = document.querySelector('select[name="budget_code"]');
    if (!el) return [];
    return Array.from(el.options).map((o) => ({ value: o.value, text: (o.textContent || "").trim() }));
  });
  return parseBudgetPotOptions(options, "AppFrm-021 budget_code select");
}
var defaultDeps = {
  fetchCards: fetchCardsFromGroupware,
  fetchOwnCardsFallback: fetchOwnCardsFromApprovedERs,
  fetchBudgetPots: fetchBudgetPotsFromGroupware
};
async function handleIpkProfileInit(sessionManager, config, _params = {}, deps = defaultDeps) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle (the MCP connection is fine). Call ipk_login again." : "Call ipk_login first"
    });
  }
  const page = sessionManager.getPage();
  const userInfo = sessionManager.getUserInfo();
  const profile = emptyProfile({ name: userInfo?.name ?? "", dept: userInfo?.dept ?? "" });
  const notDerived = [];
  let cardSignal = "corporation_card_list.php Owner column";
  try {
    profile.cards = await deps.fetchCards(page, config, userInfo);
  } catch (err) {
    notDerived.push(`cards (${err instanceof Error ? err.message : String(err)})`);
  }
  const ownCount = profile.cards.filter((c) => c.kind === "own").length;
  if (ownCount === 0) {
    try {
      const fallback = await deps.fetchOwnCardsFallback(page, config);
      if (fallback.length > 0) {
        profile.cards = [...profile.cards, ...fallback];
        cardSignal = "AppFrm-021 approved documents (card_list.php showed none this person owns)";
      }
    } catch (err) {
      notDerived.push(`cards fallback (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (profile.cards.filter((c) => c.kind === "own").length === 0) {
    notDerived.push("cards (no card attributable to this person on corporation_card_list.php or their own approved AppFrm-021 documents)");
  }
  try {
    profile.budget_pots = await deps.fetchBudgetPots(page, config);
  } catch (err) {
    notDerived.push(`budget_pots (${err instanceof Error ? err.message : String(err)})`);
  }
  if (profile.budget_pots.length === 0) notDerived.push("budget_pots (budget_code select offered none)");
  notDerived.push("approval_line (group_leader/substitute - not yet read automatically; set by hand if needed)");
  const path9 = saveProfile(profile, void 0);
  const ownCards = profile.cards.filter((c) => c.kind === "own");
  const sharedCards = profile.cards.filter((c) => c.kind === "shared");
  return textResult({
    error: false,
    data: {
      profile_path: path9,
      cards_found: ownCards.length,
      cards_signal: ownCards.length > 0 ? cardSignal : void 0,
      cards_masked: ownCards.map((c) => maskCardNumber(c.number)),
      shared_cards_seen: sharedCards.length,
      // seen on the list but not this person's - count only
      budget_pots_found: profile.budget_pots.length,
      budget_pot_codes: profile.budget_pots.map((b) => b.code),
      not_derived: notDerived,
      message: notDerived.length > 0 ? `Wrote ${path9}. Could not derive: ${notDerived.join("; ")} - ask the person for these only.` : `Wrote ${path9}. Every key was derived from the groupware; nothing left to ask.`
    }
  });
}

// src/tools/ipk-revise-attachments.ts
init_attachment_path();
init_attachment();

// src/forms/document-view.ts
var HEADER_RE = /^(.+?)\s*\((.*)\)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2})$/;
function parseApprovalOpinions(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === "Opinion of approval" || l.trim().startsWith("Opinion of approval	"));
  if (startIdx === -1) return [];
  const endIdx = lines.findIndex((l, i) => i > startIdx && l.trim().startsWith("Document Modify History"));
  const slice = lines.slice(startIdx, endIdx === -1 ? lines.length : endIdx);
  const firstLine = slice[0].replace(/^Opinion of approval\t?/, "");
  const body = [firstLine, ...slice.slice(1)].filter((l) => !/^=+$/.test(l.trim()));
  const out = [];
  for (let i = 0; i < body.length - 1; i++) {
    const m = HEADER_RE.exec(body[i].trim());
    if (!m) continue;
    const text = (body[i + 1] ?? "").trim();
    out.push({ name: m[1].trim(), role: m[2].trim(), date: m[3].trim(), text, hasOpinion: text !== "[No opinion]" && text !== "" });
    i++;
  }
  return out;
}
function parseAdditionalDocuments(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim() === "Additional document");
  if (startIdx === -1) return [];
  const out = [];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "" || line === "[ Close ] [ Print ]") break;
    const m = /([^\t[\]]+\.[a-zA-Z0-9]+)\s*\[\d+Bytes\]/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}
function parseAccountCode(bodyText) {
  const m = /\[(\d{6})\]/.exec(bodyText);
  return m ? m[1] : null;
}
function parseFileAttachmentList(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.trim().startsWith("File Attachment List"));
  if (startIdx === -1) return [];
  const firstLine = lines[startIdx].replace(/^File Attachment List\t?/, "");
  const out = [];
  for (const line of [firstLine, ...lines.slice(startIdx + 1)]) {
    const t = line.trim();
    if (t === "" || t === "[ Close ] [ Print ]") break;
    const m = /([^\t[\]]+\.[a-zA-Z0-9]+)\s*\[\d+Bytes\]/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}
function parseTakeoverDepartments(bodyText) {
  const lines = bodyText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let word;
    let j;
    if (lines[i].trim().toLowerCase() === "takeover") {
      word = "takeover";
      j = i + 1;
    } else {
      word = "";
      j = i;
      while (j < lines.length && /^[A-Za-z]$/.test(lines[j].trim())) {
        word += lines[j].trim();
        j++;
      }
    }
    if (word.toLowerCase() !== "takeover") continue;
    let k = j;
    while (k < lines.length && (lines[k].trim() === "" || /^\(\s*\d+\s*\)/.test(lines[k].trim()))) k++;
    if (k >= lines.length) return null;
    const depts = lines[k].split("	").map((s) => s.trim()).filter(Boolean);
    return depts.length > 0 ? depts : null;
  }
  return null;
}
function parseEventDates(bodyText) {
  const m = /Date\/Time\t\s*(\d{4}-\d{2}-\d{2})\s*~\s*(\d{4}-\d{2}-\d{2})/.exec(bodyText);
  return m ? { start: m[1], end: m[2] } : null;
}
function parseTotalAmount(bodyText) {
  const m = /Total\t\s*\n?\s*([\d,]+)\s*KRW/.exec(bodyText);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}
function parseCardErItemRows(bodyText) {
  const num = (c) => /^\d[\d,]*$/.test(c.trim());
  const val = (c) => Number(c.trim().replace(/,/g, ""));
  const out = [];
  for (const line of bodyText.split(/\r?\n/)) {
    const cells = line.split("	");
    for (let i = 1; i + 5 < cells.length; i++) {
      if ([1, 2, 3, 4].every((k) => num(cells[i + k])) && /^[YN]\/[YN]$/.test(cells[i + 5].trim())) {
        out.push({ item_name: cells[i].trim(), qty: val(cells[i + 1]), excl: val(cells[i + 2]), vat: val(cells[i + 3]), total: val(cells[i + 4]) });
        break;
      }
    }
  }
  return out;
}
function parseOrganizer(bodyText) {
  const m = /Organizer\t\s*(?:\[[^\]]*\]\s*)?([^\n]+)/.exec(bodyText);
  return m ? m[1].trim() : null;
}

// src/tools/ipk-revise-attachments.ts
var ipkReviseAttachmentsSchema = {
  doc_id: external_exports.string().describe("The document to revise (e.g. '301306')."),
  attachments: external_exports.array(external_exports.object({
    path: external_exports.string(),
    kind: external_exports.enum(ATTACHMENT_KINDS),
    quotes: external_exports.array(external_exports.string()).optional().describe("Text the agent itself read from this file, quoted verbatim - required for program/fee_table/society_receipt attestation on accounts that need it.")
  })).min(1).max(3).describe("1-3 files to add (the Additional document widget has 3 slots). One file = one kind."),
  attestation_exception: external_exports.array(external_exports.object({
    kind: external_exports.enum(ATTACHMENT_KINDS),
    date: external_exports.string().optional(),
    reason: external_exports.string(),
    person_confirmed: external_exports.literal(true)
  })).optional(),
  dry_run: external_exports.boolean().default(true).describe("Default true: reads the document's own opinions, existing Additional documents, and what this call would upload - never writes anything. Set false (with confirm_submit:true) to actually upload."),
  confirm_submit: external_exports.boolean().default(false).describe("Must be true for dry_run:false to actually write - attach_file_trans() saves immediately, there is no draft to undo short of deleting the file by hand.")
};
var ipkReviseAttachmentsDescription = "Add files to a card ER (AppFrm-021) returned for revision, via its Additional document widget. Shows the document's own returned opinions and existing Additional documents. dry_run=true (default) never writes anything. A real write needs dry_run=false AND confirm_submit=true. Never calls [Document Repossess] or [Revision Complete] (doc_revision_pop.php) - those remain the person's own actions.";
async function readBodyText(frame) {
  try {
    return await frame.evaluate(() => document.body ? document.body.innerText : "");
  } catch {
    return "";
  }
}
async function handleIpkReviseAttachments(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle. Call ipk_login again." : "Call ipk_login first"
    });
  }
  const docId = String(params.doc_id || "");
  if (!docId) return textResult({ error: true, code: "DOC_ID_REQUIRED", message: "doc_id is required." });
  const attachments = Array.isArray(params.attachments) ? params.attachments : [];
  if (attachments.length === 0) {
    return textResult({ error: true, code: "ATTACHMENTS_REQUIRED", message: "Provide 1-3 {path, kind} attachments." });
  }
  if (attachments.length > 3) {
    return textResult({ error: true, code: "TOO_MANY_FILES", message: "At most 3 files per revision call (the Additional document widget has 3 slots)." });
  }
  for (const a of attachments) {
    const err = validateAttachmentPath(a.path);
    if (err) return textResult({ error: true, code: "INVALID_ATTACHMENT", message: `${a.path}: ${err}` });
  }
  const page = sessionManager.getPage();
  const frame = await navigateInFrame(
    page,
    `/Document/document_view.php?doc_id=${docId}&approve_type=AppFrm-021&pop_view=y`,
    config
  ).catch(() => null);
  if (!frame) {
    return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Could not open the document (main_menu frame not found)." });
  }
  const bodyText = await readBodyText(frame);
  const opinions = parseApprovalOpinions(bodyText);
  const existingAdditionalDocuments = parseAdditionalDocuments(bodyText);
  const accountCode = parseAccountCode(bodyText);
  const eventDates = parseEventDates(bodyText);
  const totalAmount = parseTotalAmount(bodyText);
  const organizer = parseOrganizer(bodyText);
  const review = reviewAttachments({
    attachments,
    eventStart: eventDates?.start,
    eventEnd: eventDates?.end,
    totalAmount: totalAmount ?? void 0,
    issuerName: organizer ?? void 0,
    exceptions: params.attestation_exception
  });
  if (review.blocks.length > 0) {
    return textResult({
      error: true,
      code: "ATTACHMENT_REVIEW_BLOCKED",
      message: review.blocks.join("\n"),
      blocks: review.blocks,
      warnings: review.warnings
    });
  }
  if (params.dry_run !== false) {
    return textResult({
      error: false,
      data: {
        dry_run: true,
        doc_id: docId,
        opinions,
        existing_additional_documents: existingAdditionalDocuments,
        account_code: accountCode,
        would_upload: attachments.map((a) => ({ path: a.path, kind: a.kind })),
        warnings: review.warnings,
        flagged: review.flagged,
        message: `dry_run: would add ${attachments.length} file(s) to doc ${docId}'s Additional document slots. Nothing uploaded.`
      }
    });
  }
  if (params.confirm_submit !== true) {
    return textResult({
      error: true,
      code: "REVISE_CONFIRM_REQUIRED",
      message: "A real upload needs confirm_submit:true - attach_file_trans() saves immediately, with no draft to undo. Review the dry_run output first."
    });
  }
  const delNo = await frame.evaluate(() => {
    const el = document.querySelector('input[name="del_no"]');
    return el ? el.value : "";
  }).catch(() => "");
  if (delNo) {
    return textResult({
      error: true,
      code: "DEL_NO_NOT_EMPTY",
      message: `del_no is unexpectedly '${delNo}' before upload - refusing to risk a delete alongside the attach. Reload the document and retry.`
    });
  }
  const uploadResult = await attachRevisionFiles(frame, attachments.map((a) => a.path));
  const attached = uploadResult.attached;
  const skipped = uploadResult.skipped;
  await frame.evaluate(() => {
    const w = window;
    if (typeof w.attach_file_trans === "function") {
      w.attach_file_trans();
      return;
    }
    const modeEl = document.querySelector('input[name="mode"]');
    if (modeEl) modeEl.value = "tran_file";
    const form = document.form1;
    if (form && typeof form.submit === "function") form.submit();
  }).catch(() => void 0);
  await page.waitForTimeout(1500).catch(() => void 0);
  const afterText = await readBodyText(frame);
  const afterDocs = parseAdditionalDocuments(afterText);
  audit({
    action: "upload",
    docId,
    field: "trans_attach_file[]",
    value: JSON.stringify(attachments.map((a) => ({ path: a.path, kind: a.kind }))),
    validated: true,
    ok: attached === attachments.length
  });
  return textResult({
    error: false,
    data: {
      doc_id: docId,
      attached,
      skipped,
      existing_additional_documents_before: existingAdditionalDocuments,
      existing_additional_documents_after: afterDocs,
      message: `${attached}/${attachments.length} file(s) added to doc ${docId}'s Additional document slots.`
    }
  });
}

// src/tools/ipk-precedent-attachments.ts
import * as fs10 from "fs";
import * as path7 from "path";

// src/precedent/attachment-precedent.ts
var STOPWORD_TOKEN = /^\d+$/;
function filenameTokens(filename) {
  const base = filename.replace(/\.[a-zA-Z0-9]+$/, "");
  return base.split(/[-_.\s]+/).map((t) => t.toLowerCase()).filter((t) => t.length > 2 && !STOPWORD_TOKEN.test(t));
}
function frequentFilenameTokens(filenameLists) {
  const counts = /* @__PURE__ */ new Map();
  for (const filenames of filenameLists) {
    for (const f of filenames) {
      for (const t of filenameTokens(f)) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([token, count2]) => ({ token, count: count2 })).sort((a, b) => b.count - a.count || a.token.localeCompare(b.token));
}
function buildPrecedentReport(account, rawDocs) {
  const docs = [];
  for (const d of rawDocs) {
    if (parseAccountCode(d.bodyText) !== account) continue;
    const filenames = [...parseFileAttachmentList(d.bodyText), ...parseAdditionalDocuments(d.bodyText)];
    docs.push({ docId: d.docId, filenames });
  }
  const frequentTokens = frequentFilenameTokens(docs.map((d) => d.filenames));
  const candidateRowText = docs.length === 0 ? `No precedent documents found for account ${account} in range - nothing to propose.` : `Candidate ACCOUNT_ATTACHMENTS_REQUIRED row for ${account}: ${docs.length} precedent doc(s), frequent filename tokens - ${frequentTokens.slice(0, 8).map((t) => `${t.token}(${t.count})`).join(", ")}. A person must label these into kinds before this becomes a rule - this is a proposal, not a rule change.`;
  return { account, docsScanned: rawDocs.length, docsFound: docs.length, docs, frequentTokens, candidateRowText };
}

// src/tools/ipk-precedent-attachments.ts
var ipkPrecedentAttachmentsSchema = {
  account: external_exports.string().describe("Account code to collect precedent for (e.g. '410306')."),
  months: external_exports.number().default(12).describe("How many months back to search groupapproved documents."),
  max_docs: external_exports.number().default(40).describe("Cap on how many candidate documents to open (politeness/cost bound)."),
  exclude_doc_ids: external_exports.array(external_exports.string()).optional().describe("doc_ids to skip in addition to this tool's own past drafts (toolDraftedDocIds).")
};
var ipkPrecedentAttachmentsDescription = "OFFLINE, read-only: collects colleagues' groupapproved card ER (AppFrm-021) attachment filenames for one account over the last N months, and proposes (as text, never a rule change) candidate attachment kinds for ACCOUNT_ATTACHMENTS_REQUIRED. Never called from a save path. Cached under ~/.cache/ipk-mcp/, never the repo.";
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function cacheDir() {
  return path7.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp", "precedent-attachments");
}
async function readBodyText2(frame) {
  try {
    return await frame.evaluate(() => document.body ? document.body.innerText : "");
  } catch {
    return "";
  }
}
async function readApproveType(frame) {
  try {
    return await frame.evaluate(() => {
      const el = document.querySelector('input[name="approve_type"]');
      return el ? el.value : null;
    });
  } catch {
    return null;
  }
}
async function handleIpkPrecedentAttachments(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle. Call ipk_login again." : "Call ipk_login first"
    });
  }
  const account = String(params.account || "");
  if (!account) return textResult({ error: true, code: "ACCOUNT_REQUIRED", message: "account is required." });
  const months = Number(params.months) || 12;
  const maxDocs = Number(params.max_docs) || 40;
  const page = sessionManager.getPage();
  const today = /* @__PURE__ */ new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const sDate = isoDate(start);
  const eDate = isoDate(today);
  const listFrame = await navigateInFrame(
    page,
    `/Document/document_list.php?type=groupapproved&s_date=${sDate}&e_date=${eDate}&writer=Y&title=Y&contents=Y&attachment=Y`,
    config
  ).catch(() => null);
  if (!listFrame) {
    return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Could not open the groupapproved document list." });
  }
  const allDocIds = await listFrame.evaluate(() => {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const links = document.querySelectorAll("a[href*='doc_id=']");
    for (const link of links) {
      const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }).catch(() => []);
  const excluded = /* @__PURE__ */ new Set([
    ...toolDraftedDocIds(),
    ...Array.isArray(params.exclude_doc_ids) ? params.exclude_doc_ids.map(String) : []
  ]);
  const candidates = allDocIds.filter((id) => !excluded.has(id)).slice(0, maxDocs);
  const rawDocs = [];
  let visited = 0;
  for (const docId of candidates) {
    const frame = await navigateInFrame(page, `/Document/document_view.php?doc_id=${docId}&pop_view=y`, config).catch(() => null);
    if (!frame) continue;
    visited += 1;
    const approveType = await readApproveType(frame);
    if (approveType !== "AppFrm-021") continue;
    const bodyText = await readBodyText2(frame);
    rawDocs.push({ docId, bodyText });
  }
  const report = buildPrecedentReport(account, rawDocs);
  report.docsScanned = visited;
  let cachedAt = null;
  try {
    const dir = cacheDir();
    fs10.mkdirSync(dir, { recursive: true, mode: 448 });
    cachedAt = path7.join(dir, `${account}-${eDate}.json`);
    fs10.writeFileSync(cachedAt, JSON.stringify({ sDate, eDate, ...report }, null, 2), "utf8");
  } catch {
  }
  return textResult({
    error: false,
    data: { ...report, range: { s_date: sDate, e_date: eDate }, cached_at: cachedAt }
  });
}

// src/tools/ipk-card-er-fix-vat.ts
var ipkCardErFixVatSchema = {
  doc_id: external_exports.string().regex(/^\d+$/).describe("The card ER draft to correct (must be in the person's type=drafts list)."),
  dry_run: external_exports.boolean().default(true).describe(
    'Default true: reads the draft, fills VAT 0 / excl. VAT = total in the Edit page and reports it - saves nothing. false: needs a one-time { "doc:<doc_id>": { "doc_id": "<doc_id>", "authorized_at": "<ISO>", "note": "..." } } entry in ~/.config/ipk-browser-mcp/card-er-draft-authorizations.json, consumed before any click.'
  )
};
var ipkCardErFixVatDescription = "Correct one existing card ER (AppFrm-021) DRAFT of an overseas IT subscription (RunPod/Claude/OpenAI/Google Cloud/...) to VAT 0 and Amount excl. VAT = Total, through the Edit page's own [Save] (mode1='drafts'; never [Request]). Refuses docs not in type=drafts, filed docs, multi-row docs and non-overseas items. Reads document_view back after saving: DRAFT_UPDATED / SUBMITTED_NOT_DRAFT / DRAFT_NOT_CONFIRMED / VALUES_NOT_UPDATED.";
function readEditRowState() {
  const w = window;
  const at = (n) => document.getElementsByName(n)[1];
  const cnt = document.getElementsByName("er_row_cnt")[0];
  const subj = document.querySelector('input[name="subject"]');
  return {
    rows: cnt ? String(cnt.value) : "",
    item_name: at("item_name[]")?.value ?? "",
    total_attr: at("item_amount[]")?.getAttribute("value") ?? "",
    total_value: at("item_amount[]")?.value ?? "",
    vat: at("item_amount_vat[]")?.value ?? "",
    excl: at("item_amount_ral1[]")?.value ?? "",
    subject: subj ? subj.value : "",
    has_process_money: typeof w.process_money === "function",
    has_edit_check: typeof w.fn_Edit_Check === "function",
    mod_reasons: document.getElementsByName("MOD_REASONS").length > 0
  };
}
function applyOverseasVatZero(total) {
  const at = (n) => document.getElementsByName(n)[1];
  const vat = at("item_amount_vat[]");
  const excl = at("item_amount_ral1[]");
  if (vat) vat.value = "0";
  if (excl) excl.value = total;
  window.process_money();
  const amt = document.getElementById("total_amt");
  return { total_value: at("item_amount[]")?.value ?? "", total_amt: amt ? amt.value : "", vat: vat?.value ?? "", excl: excl?.value ?? "" };
}
function runEditSaveFlow() {
  const w = window;
  const st = w.__ipkCardEr;
  try {
    if (typeof w.fn_Edit_Check !== "function") throw new Error("fn_Edit_Check is not defined on this page");
    w.fn_Edit_Check("update", "drafts");
  } catch (err) {
    st.pageError = err instanceof Error ? err.message : String(err);
  }
  return JSON.parse(JSON.stringify(st));
}
function readEditHref() {
  return Array.from(document.querySelectorAll("a")).map((a) => a.getAttribute("href") || "").filter((h) => h.includes("document_write.php"));
}
function readBodyText3() {
  return document.body ? document.body.innerText : "";
}
var refuse = (code, message, extra = {}) => textResult({ error: true, code, message, ...extra });
async function handleIpkCardErFixVat(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return refuse("NOT_LOGGED_IN", sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle. Call ipk_login again." : "Call ipk_login first");
  }
  const docId = String(params.doc_id ?? "");
  if (!/^\d+$/.test(docId)) return refuse("DOC_ID_REQUIRED", "doc_id must be a numeric document id.");
  const page = sessionManager.getPage();
  const viewPath = `/Document/document_view.php?doc_id=${docId}&approve_type=AppFrm-021&type=drafts`;
  const listPath = "/Document/document_list.php?type=drafts";
  const inDrafts = async () => {
    try {
      const f = await navigateInFrame(page, listPath, config);
      return f ? listHasDoc(String(await f.content()), docId) : null;
    } catch {
      return null;
    }
  };
  if (await inDrafts() !== true) {
    return refuse("NOT_IN_DRAFTS", `doc ${docId} is not in document_list.php?type=drafts (or the list could not be read). Only drafts are edited. Nothing was changed.`);
  }
  const frame = await navigateInFrame(page, viewPath, config).catch(() => null);
  if (!frame) return refuse("NAVIGATION_FAILED", "Could not open the document (main_menu frame not found). Nothing was changed.");
  const viewText = String(await frame.evaluate(readBodyText3).catch(() => "") ?? "");
  const markers = detectSubmittedOnDocumentView(viewText);
  if (markers.length > 0) {
    return refuse("NOT_A_DRAFT", `doc ${docId}'s document_view shows ${markers.join(" and ")} - it is filed, not a draft. Nothing was changed.`, { submitted_markers: markers });
  }
  const rows = parseCardErItemRows(viewText);
  if (rows.length !== 1) {
    return refuse("ROWS_UNSUPPORTED", `doc ${docId} has ${rows.length} readable item row(s); only single-row card ERs are corrected. Nothing was changed.`, { rows });
  }
  const before = rows[0];
  if (!isOverseasItSubscription(before.item_name)) {
    return refuse("NOT_OVERSEAS_IT_SUBSCRIPTION", `"${before.item_name}" is not an overseas IT subscription; its VAT split is not changed here. Nothing was changed.`, { before });
  }
  if (before.vat === 0 && before.excl === before.total) {
    return textResult({ error: false, data: { doc_id: docId, outcome: "NOTHING_TO_FIX", before, message: `doc ${docId} already has VAT 0 and excl. VAT = total (${before.total}). Nothing was changed.` } });
  }
  const attachmentsBefore = parseFileAttachmentList(viewText);
  const hrefs = await frame.evaluate(readEditHref).catch(() => []);
  const origin = new URL(config.baseUrl).origin;
  const editUrl = hrefs.map((h) => {
    try {
      return new URL(h, `${origin}/Document/document_view.php`).toString();
    } catch {
      return "";
    }
  }).find((u) => new RegExp(`[?&]doc_id=${docId}(?!\\d)`).test(u) && /[?&]type=drafts(?:&|$)/.test(u) && /[?&]approve_type=AppFrm-021(?:&|$)/.test(u));
  if (!editUrl) return refuse("EDIT_LINK_NOT_FOUND", `doc ${docId}'s document_view has no [Edit] link to document_write.php with type=drafts. Nothing was changed.`, { hrefs });
  await navigateInFrame(page, editUrl, config);
  const state = await frame.evaluate(readEditRowState);
  const total = String(before.total);
  const problems = [];
  if (state.rows !== "1") problems.push(`er_row_cnt is '${state.rows}', not '1'`);
  if (state.item_name.trim() !== before.item_name) problems.push(`row 1 item_name '${state.item_name}' differs from document_view '${before.item_name}'`);
  if (state.total_attr !== total) problems.push(`row 1 server total '${state.total_attr}' differs from document_view total ${total}`);
  if (!state.has_process_money || !state.has_edit_check) problems.push("process_money/fn_Edit_Check missing");
  if (state.mod_reasons) problems.push("the page asks for a modification reason (MOD_REASONS)");
  if (problems.length > 0) {
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return refuse("EDIT_PAGE_UNEXPECTED", `The Edit page is not the one this was built against: ${problems.join("; ")}. Nothing was changed.`, { state });
  }
  const expected = { excl: before.total, vat: 0, total: before.total };
  if (params.dry_run !== false) {
    const filled2 = await frame.evaluate(applyOverseasVatZero, total);
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return textResult({
      error: false,
      data: {
        dry_run: true,
        doc_id: docId,
        before,
        edit_page_on_load: { excl: state.excl, vat: state.vat, total: state.total_value },
        would_set: expected,
        filled_in_page: filled2,
        attachments: attachmentsBefore,
        message: `dry_run: doc ${docId} would be saved through the Edit page's own [ Save ] (mode1='drafts') with excl. VAT ${total}, VAT 0, total ${total}. Nothing was saved; the page was left without saving. A save needs a "doc:${docId}" entry in ${cardErAuthorizationPath()}.`
      }
    });
  }
  let auth = null;
  try {
    auth = consumeCardErDocEditAuthorization(docId);
  } catch (err) {
    return refuse("CARD_ER_EDIT_REFUSED", `The authorization for doc ${docId} could not be consumed (${err instanceof Error ? err.message : String(err)}). Nothing was clicked.`);
  }
  if (!auth) {
    await navigateInFrame(page, viewPath, config).catch(() => null);
    return refuse(
      "CARD_ER_EDIT_REFUSED",
      `Saving doc ${docId} needs a one-time authorization: ${cardErAuthorizationPath()} has no "doc:${docId}": { "doc_id": "${docId}", "authorized_at": "<ISO>", "note": "..." } entry. A person adds it; the tool consumes it before clicking, so each entry allows one save attempt. Nothing was saved.`
    );
  }
  audit({ action: "draft_save", code: "AUTHORIZATION_CONSUMED", field: "card_er_fix_vat", docId, mode: "draft", value: JSON.stringify({ key: `doc:${docId}`, ...auth }), ok: true });
  const filled = await frame.evaluate(applyOverseasVatZero, total);
  if (filled.total_value !== total || filled.total_amt !== total || filled.vat !== "0" || filled.excl !== total) {
    return refuse("VALUE_SET_FAILED", `After setting VAT 0 / excl. VAT ${total}, the page shows ${JSON.stringify(filled)}. Nothing was clicked. The authorization was consumed.`, { filled });
  }
  return await saveCardExpenseRDDraft(
    page,
    frame,
    config,
    { subject: state.subject, effectiveBudgetCode: null, attachResult: { attached: 0, skipped: [] }, fileCount: 0 },
    {
      mode1: "drafts",
      runner: runEditSaveFlow,
      finish: async () => {
        const afterFrame = await navigateInFrame(page, viewPath, config).catch(() => null);
        const afterText = afterFrame ? String(await afterFrame.evaluate(readBodyText3).catch(() => "") ?? "") : "";
        const base = { doc_id: docId, document_view: `${origin}${viewPath}`, before, expected };
        const filedMarkers = detectSubmittedOnDocumentView(afterText);
        if (filedMarkers.length > 0) {
          audit({ action: "refusal", code: "SUBMITTED_NOT_DRAFT", docId, mode: "draft", ok: false });
          return refuse(
            "SUBMITTED_NOT_DRAFT",
            `doc ${docId} was FILED FOR APPROVAL by the save: document_view shows ${filedMarkers.join(" and ")}. The tool did not retry and did not repossess it - the person decides.`,
            { ...base, submitted_markers: filedMarkers }
          );
        }
        if (!afterText.trim()) {
          return refuse("DRAFT_NOT_CONFIRMED", `submit_form() ran for doc ${docId} but its document_view could not be read. Check it before retrying.`, base);
        }
        const after = parseCardErItemRows(afterText)[0];
        const attachmentsAfter = parseFileAttachmentList(afterText);
        const stillDraft = await inDrafts();
        const details = { ...base, after: after ?? null, attachments_before: attachmentsBefore, attachments_after: attachmentsAfter, in_drafts: stillDraft };
        if (stillDraft !== true) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "DRAFT_NOT_CONFIRMED" });
          return refuse("DRAFT_NOT_CONFIRMED", `submit_form() ran; document_view shows no filed marker, but doc ${docId} is not in type=drafts. Check it before retrying.`, details);
        }
        if (!after || after.excl !== expected.excl || after.vat !== expected.vat || after.total !== expected.total) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "VALUES_NOT_UPDATED" });
          return refuse("VALUES_NOT_UPDATED", `doc ${docId} is still a draft, but document_view shows ${JSON.stringify(after ?? null)}, not ${JSON.stringify(expected)}.`, details);
        }
        const lost = attachmentsBefore.filter((f) => !attachmentsAfter.includes(f));
        if (lost.length > 0) {
          audit({ action: "draft_save", docId, mode: "draft", ok: false, code: "ATTACHMENTS_LOST" });
          return refuse("ATTACHMENTS_LOST", `doc ${docId} was updated and is still a draft, but these attachments are gone: ${lost.join(", ")}.`, details);
        }
        audit({ action: "draft_save", docId, mode: "draft", confirmed: true, ok: true, code: "DRAFT_UPDATED" });
        return textResult({
          error: false,
          data: {
            ...details,
            success: true,
            outcome: "DRAFT_UPDATED",
            message: `doc ${docId} is still a draft (type=drafts, no filed marker) and now shows excl. VAT ${after.excl}, VAT ${after.vat}, total ${after.total}.`
          }
        });
      }
    }
  );
}

// src/tools/ipk-reviewer-opinions.ts
import * as fs11 from "fs";
import * as path8 from "path";

// src/precedent/reviewer-opinions.ts
var DEPT_ALIASES = {
  "Budget Planning & Finance": ["BPF", "Budget Planning & Finance", "Budget Planning and Finance"]
};
function matchesDept(roleDept, takeoverDept) {
  const aliases = DEPT_ALIASES[takeoverDept] ?? [takeoverDept];
  return aliases.some((a) => a.toLowerCase() === roleDept.toLowerCase());
}
function roleDepartment(role) {
  const idx = role.indexOf(" - ");
  return (idx === -1 ? role : role.slice(0, idx)).trim();
}
function extractProcessingOpinions(docId, drafter, formType, accountCode, bodyText) {
  const takeoverDepts = parseTakeoverDepartments(bodyText) ?? [];
  const opinions = [];
  const unmatched = /* @__PURE__ */ new Set();
  if (takeoverDepts.length === 0) return { opinions, unmatchedDepartments: [] };
  const real = parseApprovalOpinions(bodyText).filter((o) => o.hasOpinion);
  for (const o of real) {
    const dept = roleDepartment(o.role);
    if (o.name === drafter) continue;
    if (takeoverDepts.some((td) => matchesDept(dept, td))) {
      opinions.push({ docId, drafter, formType, accountCode, department: dept, text: o.text });
    } else {
      unmatched.add(dept);
    }
  }
  return { opinions, unmatchedDepartments: [...unmatched] };
}
function normalizeTokens(text) {
  return new Set(
    text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((t) => t.length > 1)
  );
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
function clusterOpinions(opinions, threshold = 0.5) {
  const groups = /* @__PURE__ */ new Map();
  for (const o of opinions) {
    const key = `${o.formType}|${o.accountCode ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(o);
    else groups.set(key, [o]);
  }
  const candidates = [];
  for (const [key, group] of groups) {
    const [formType, accountCodeRaw] = key.split("|");
    const accountCode = accountCodeRaw || null;
    const clusters = [];
    for (const o of group) {
      const tokens = normalizeTokens(o.text);
      const match = clusters.find((c) => jaccard(tokens, c.tokens) >= threshold);
      if (match) match.members.push(o);
      else clusters.push({ tokens, members: [o] });
    }
    for (const c of clusters) {
      const docIds = [...new Set(c.members.map((m) => m.docId))];
      const drafters = [...new Set(c.members.map((m) => m.drafter))];
      if (docIds.length >= 2 && drafters.length >= 2) {
        candidates.push({
          formType,
          accountCode,
          department: c.members[0].department,
          representativeText: c.members[0].text,
          docIds,
          drafters
        });
      }
    }
  }
  return candidates;
}

// src/tools/ipk-reviewer-opinions.ts
var ipkReviewerOpinionsSchema = {
  months: external_exports.number().default(12).describe("How many months back to search groupapproved documents."),
  max_docs: external_exports.number().default(60).describe("Cap on how many documents to open (politeness/cost bound).")
};
var ipkReviewerOpinionsDescription = "OFFLINE, read-only, LOCAL ONLY: collects processing-department opinions (e.g. Budget Planning & Finance) across groupapproved documents and flags a request repeated by >=2 different drafters as a rule candidate, with doc_id evidence. Never called from a save path, never writes to the groupware. Full detail (names, opinion text) is cached under ~/.cache/ipk-mcp/ only; the MCP result reports counts/candidates/unmatched departments, not raw names.";
function cacheDir2() {
  return path8.join(process.env.HOME || "/tmp", ".cache", "ipk-mcp", "reviewer-opinions");
}
async function readBodyText4(frame) {
  try {
    return await frame.evaluate(() => document.body ? document.body.innerText : "");
  } catch {
    return "";
  }
}
async function readField(frame, name) {
  try {
    return await frame.evaluate((n) => {
      const el = document.querySelector(`input[name="${n}"]`);
      return el ? el.value : null;
    }, name);
  } catch {
    return null;
  }
}
function parseDrafterName(bodyText) {
  const m = /Drafter\t[^\t\n]*-\s*([^(\t\n]+?)\s*\(/.exec(bodyText);
  return m ? m[1].trim() : null;
}
async function handleIpkReviewerOpinions(sessionManager, config, params) {
  if (!sessionManager.isLoggedIn()) {
    return textResult({
      error: true,
      code: "NOT_LOGGED_IN",
      message: sessionManager.getLoginState() === "expired" ? "Browser session expired after 30 minutes idle. Call ipk_login again." : "Call ipk_login first"
    });
  }
  const months = Number(params.months) || 12;
  const maxDocs = Number(params.max_docs) || 60;
  const page = sessionManager.getPage();
  const today = /* @__PURE__ */ new Date();
  const start = new Date(today);
  start.setMonth(start.getMonth() - months);
  const sDate = start.toISOString().slice(0, 10);
  const eDate = today.toISOString().slice(0, 10);
  const listFrame = await navigateInFrame(
    page,
    `/Document/document_list.php?type=groupapproved&s_date=${sDate}&e_date=${eDate}&writer=Y&title=Y&contents=Y&attachment=Y`,
    config
  ).catch(() => null);
  if (!listFrame) {
    return textResult({ error: true, code: "NAVIGATION_FAILED", message: "Could not open the groupapproved document list." });
  }
  const allDocIds = await listFrame.evaluate(() => {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    const links = document.querySelectorAll("a[href*='doc_id=']");
    for (const link of links) {
      const m = (link.getAttribute("href") || "").match(/doc_id=([^&]+)/);
      if (m && !seen.has(m[1])) {
        seen.add(m[1]);
        out.push(m[1]);
      }
    }
    return out;
  }).catch(() => []);
  const candidates = allDocIds.slice(0, maxDocs);
  const allOpinions = [];
  const unmatchedDepartments = /* @__PURE__ */ new Set();
  let docsWithTakeover = 0;
  let visited = 0;
  for (const docId of candidates) {
    const frame = await navigateInFrame(page, `/Document/document_view.php?doc_id=${docId}&pop_view=y`, config).catch(() => null);
    if (!frame) continue;
    visited += 1;
    const bodyText = await readBodyText4(frame);
    const drafter = parseDrafterName(bodyText) || "";
    const approveType = await readField(frame, "approve_type") || "unknown";
    const accountCode = parseAccountCode(bodyText);
    const { opinions, unmatchedDepartments: unmatched } = extractProcessingOpinions(docId, drafter, approveType, accountCode, bodyText);
    if (opinions.length > 0 || unmatched.length > 0) docsWithTakeover += 1;
    allOpinions.push(...opinions);
    for (const u of unmatched) unmatchedDepartments.add(u);
  }
  const candidatesFound = clusterOpinions(allOpinions);
  let cachedAt = null;
  try {
    const dir = cacheDir2();
    fs11.mkdirSync(dir, { recursive: true, mode: 448 });
    cachedAt = path8.join(dir, `reviewer-opinions-${eDate}.json`);
    fs11.writeFileSync(cachedAt, JSON.stringify({
      sDate,
      eDate,
      docsScanned: visited,
      docsWithTakeover,
      opinions: allOpinions,
      candidates: candidatesFound,
      unmatchedDepartments: [...unmatchedDepartments]
    }, null, 2), "utf8");
  } catch {
  }
  return textResult({
    error: false,
    data: {
      range: { s_date: sDate, e_date: eDate },
      docs_scanned: visited,
      docs_with_takeover_opinions: docsWithTakeover,
      processing_opinions_found: allOpinions.length,
      rule_candidates: candidatesFound.map((c) => ({
        form_type: c.formType,
        account_code: c.accountCode,
        department: c.department,
        summary: c.representativeText.slice(0, 200),
        doc_ids: c.docIds,
        drafter_count: c.drafters.length
      })),
      unmatched_departments: [...unmatchedDepartments],
      cached_at: cachedAt,
      message: `${visited} doc(s) scanned, ${allOpinions.length} processing-department opinion(s) found, ${candidatesFound.length} rule candidate(s). Full detail (names, verbatim text) is local-only at ${cachedAt ?? "(cache write failed)"}.`
    }
  });
}

// src/handlers.ts
var SHIM_API = SHIM_API_VERSION;
var tools = [
  {
    name: "ipk_login",
    description: ipkLoginDescription,
    schema: ipkLoginSchema,
    handler: (c, p) => handleIpkLogin(c.sessionManager, p)
  },
  {
    name: "ipk_submit_form",
    description: ipkSubmitFormDescription,
    schema: ipkSubmitFormSchema,
    handler: (c, p) => handleIpkSubmitForm(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_fetch_approvals",
    description: ipkFetchApprovalsDescription,
    schema: ipkFetchApprovalsSchema,
    handler: (c, p) => handleIpkFetchApprovals(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_navigate",
    description: ipkNavigateDescription,
    schema: ipkNavigateSchema,
    handler: (c, p) => handleIpkNavigate(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_get_content",
    description: ipkGetContentDescription,
    schema: ipkGetContentSchema,
    handler: (c, p) => handleIpkGetContent(c.sessionManager, c.config, p)
  },
  {
    name: "screenshot",
    description: screenshotDescription,
    schema: screenshotSchema,
    handler: (c, p) => handleScreenshot(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_inspect_form",
    description: ipkInspectFormDescription,
    schema: ipkInspectFormSchema,
    handler: (c, p) => handleIpkInspectForm(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_profile_init",
    description: ipkProfileInitDescription,
    schema: ipkProfileInitSchema,
    handler: (c, p) => handleIpkProfileInit(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_revise_attachments",
    description: ipkReviseAttachmentsDescription,
    schema: ipkReviseAttachmentsSchema,
    handler: (c, p) => handleIpkReviseAttachments(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_precedent_attachments",
    description: ipkPrecedentAttachmentsDescription,
    schema: ipkPrecedentAttachmentsSchema,
    handler: (c, p) => handleIpkPrecedentAttachments(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_reviewer_opinions",
    description: ipkReviewerOpinionsDescription,
    schema: ipkReviewerOpinionsSchema,
    handler: (c, p) => handleIpkReviewerOpinions(c.sessionManager, c.config, p)
  },
  {
    name: "ipk_card_er_fix_vat",
    description: ipkCardErFixVatDescription,
    schema: ipkCardErFixVatSchema,
    handler: (c, p) => handleIpkCardErFixVat(c.sessionManager, c.config, p)
  }
];
function startup(ctx) {
  cleanupExpiredScreenshots(ctx.config);
}
function parseArgs(shape, args) {
  const r = external_exports.object(shape).safeParse(args);
  return r.success ? { success: true, data: r.data } : { success: false, error: r.error.message };
}
export {
  SHIM_API,
  parseArgs,
  startup,
  tools
};
