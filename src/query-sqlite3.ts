// pe-sqlite-for-rxdb
// Copyright 2024 Pineapple Electric LLC
//
// This program is free software: you can redistribute it and/or modify it
// under the terms of the GNU Affero General Public License as published by the
// Free Software Foundation, either version 3 of the License, or (at your
// option) any later version.
//
// This program is distributed in the hope that it will be useful, but WITHOUT
// ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
// FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License
// for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import type {
  JsonSchema,
  MangoQuerySelector,
  MangoQuerySortPart,
  Paths,
  PreparedQuery,
  RxDocumentData,
  RxJsonSchema,
  StringKeys,
  TopLevelProperty,
} from "rxdb";
import type { ColumnMap } from "./types";

import { getPrimaryFieldOfPrimaryKey } from "rxdb";

// Args which our SQLiteImpl can serialize.
export type ArgsType = Array<string | number | Buffer>;

export interface OrderByClause {
  clause: string;
}

export interface QueryAndArgs {
  args: ArgsType;
  query: string;
}

export interface WhereConditions {
  condition: string;
  args: ArgsType;
}

type DocumentProperties<T> = {
  [key in StringKeys<T>]: JsonSchema<T> | TopLevelProperty;
};

export class RxStoragePESQLiteQueryBuilder<RxDocType> {
  private _columnMap?: ColumnMap<RxDocumentData<RxDocType>>;

  constructor(
    readonly collectionSchema: RxJsonSchema<RxDocumentData<RxDocType>>,
  ) {}

  get columnMap(): ColumnMap<RxDocumentData<RxDocType>> {
    if (this._columnMap !== undefined) {
      return this._columnMap;
    }
    this._columnMap = this.columnMapWithProperties(
      [],
      this.collectionSchema.properties,
    );
    return this._columnMap;
  }

  queryAndArgsWithPreparedQuery(
    preparedQuery: PreparedQuery<RxDocType>,
  ): QueryAndArgs {
    const rootPath = "" as Paths<RxDocumentData<RxDocType>>;
    const selector: MangoQuerySelector<RxDocumentData<RxDocType>> =
      preparedQuery.query.selector;
    const whereConditions = this.operatorAndObject(rootPath, selector);
    const orderBy = this.orderByWithPreparedQuery(preparedQuery);
    return this.queryAndArgsWithWhereConditionsAndOrderBy(
      whereConditions,
      orderBy,
    );
  }

  private argsWithMangoQuerySelector(
    querySelector: MangoQuerySelector<RxDocumentData<RxDocType>>,
    booleanAsText: boolean = false,
  ): ArgsType {
    if (typeof querySelector === "boolean") {
      if (booleanAsText) {
        return [querySelector === true ? "true" : "false"];
      } else {
        return [querySelector === true ? 1 : 0];
      }
    } else if (
      typeof querySelector === "number" ||
      typeof querySelector === "string"
    ) {
      return [querySelector];
    }
    throw new Error(
      `Query selector ${querySelector.toString()} cannot be converted to query arguments`,
    );
  }

  /**
   * Build a map of document keys to database columns and JSON paths.
   *
   * This allows us to query columns, when those are available, and verify that
   * the document keys are valid for the schema.
   */
  private columnMapWithProperties(
    prefix: Paths<RxDocumentData<RxDocType>>[],
    properties: DocumentProperties<RxDocumentData<RxDocType>>,
  ): ColumnMap<RxDocumentData<RxDocType>> {
    const result: ColumnMap<RxDocumentData<RxDocType>> = new Map();
    const prefixString = prefix.length ? prefix.join(".") + "." : "";
    const primaryField = getPrimaryFieldOfPrimaryKey(
      this.collectionSchema.primaryKey,
    );
    for (const [untypedKey, untypedValue] of Object.entries(properties)) {
      const key = untypedKey as StringKeys<RxDocumentData<RxDocType>>;
      const value = untypedValue as TopLevelProperty;
      const propertyKey = (prefixString + key) as Paths<
        RxDocumentData<RxDocType>
      >;
      if (key === "_deleted" && value.type === "boolean") {
        result.set(propertyKey, { column: "deleted", type: "boolean" });
        continue;
      } else if (
        key === "lwt" &&
        propertyKey === "_meta.lwt" &&
        value.type === "number"
      ) {
        result.set(propertyKey, { column: "mtime_ms", type: "number" });
      } else if (key === "_rev" && value.type === "string") {
        result.set(propertyKey, { column: "rev", type: "string" });
        continue;
      } else if (key === primaryField) {
        if (value.type !== undefined) {
          result.set(propertyKey, { column: "id", type: value.type });
        } else {
          throw new Error(`Property key ${propertyKey} has undefined type`);
        }
        continue;
      } else if (key === "_attachments") {
        // Attachments are not a column.
        continue;
      } else if (
        value.type === "string" ||
        value.type === "boolean" ||
        value.type === "number"
      ) {
        result.set(propertyKey, {
          jsonPath: "$." + propertyKey,
          type: value.type,
        });
      } else if (
        value.type === "object" &&
        value.additionalProperties === true &&
        typeof value.properties === "object"
      ) {
        prefix.push(untypedKey as Paths<RxDocumentData<RxDocType>>);
        const innerProperties = value.properties as DocumentProperties<
          RxDocumentData<RxDocType>
        >;
        const innerMap = this.columnMapWithProperties(prefix, innerProperties);
        prefix.pop();
        for (const [innerKey, innerValue] of innerMap.entries()) {
          result.set(innerKey, innerValue);
        }
      }
    }
    return result;
  }

  // TODO: Combine joinConditionsAnd and joinConditionsOr using partial functions.
  private joinConditionsAnd(conditions: WhereConditions[]): WhereConditions {
    const allConditions: string[] = [];
    const allArgs: Array<string | number | Buffer> = [];

    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];
      allConditions.push(condition.condition);
      allArgs.push(...condition.args);
    }
    const result: WhereConditions = {
      condition: allConditions.join(" AND "),
      args: allArgs,
    };
    return result;
  }

  private joinConditionsOr(conditions: WhereConditions[]): WhereConditions {
    const allConditions: string[] = [];
    const allArgs: Array<string | number | Buffer> = [];

    for (let i = 0; i < conditions.length; i++) {
      const condition = conditions[i];
      allConditions.push(condition.condition);
      allArgs.push(...condition.args);
    }
    const result: WhereConditions = {
      condition: allConditions.join(" OR "),
      args: allArgs,
    };
    return result;
  }

  private operatorAndArray(
    prefix: Paths<RxDocumentData<RxDocType>>,
    selector: MangoQuerySelector<RxDocumentData<RxDocType>>[],
  ): WhereConditions {
    const conditions: WhereConditions[] = [];
    if (Array.isArray(selector)) {
      for (let i = 0; i < selector.length; i++) {
        const currentSelector = selector[i];
        if (typeof currentSelector === "object") {
          const innerConditions = this.operatorAndObject(
            prefix,
            currentSelector,
          );
          conditions.push(innerConditions);
        } else {
          throw new Error(
            `Every member of an $and array must be an object: selector[${i}] = ${currentSelector}`,
          );
        }
      }
    } else {
      throw new Error(
        `operatorAndArray received a non-Array argument ${selector}`,
      );
    }
    const result = this.joinConditionsAnd(conditions);
    return result;
  }

  private operatorAndObject(
    prefix: Paths<RxDocumentData<RxDocType>>,
    selector: MangoQuerySelector<RxDocumentData<RxDocType>>,
  ): WhereConditions {
    const conditions: WhereConditions[] = [];
    for (const [key, value] of Object.entries(selector)) {
      if (typeof key === "string") {
        if (Array.isArray(value)) {
          if (key.length >= 3 && key[0] === "$") {
            if (key === "$and") {
              conditions.push(this.operatorAndArray(prefix, value));
            } else if (key === "$or") {
              conditions.push(this.operatorOrArray(prefix, value));
            } else {
              throw new Error(
                `1.Unable to handle key ${key} with value Array ${value}`,
              );
            }
          } else {
            throw new Error(
              `2.Unable to handle key ${key} with value Array ${value}`,
            );
          }
        } else {
          const keyAsPath = key as Paths<RxDocumentData<RxDocType>>;
          if (key.length >= 3 && key[0] === "$") {
            // Operators
            if (key === "$eq") {
              conditions.push(this.operatorEquals(prefix, value));
            } else if (key === "$and" || key === "$or") {
              throw `Unable to handle key ${key} with non-Array value ${value}`;
            }
          } else if (this.columnMap.has(keyAsPath)) {
            // Found a column
            const innerPrefix = this.prefixWithChild(prefix, key);
            conditions.push(this.operatorEquals(innerPrefix, value));
          }
        }
      }
    }
    const result = this.joinConditionsAnd(conditions);
    return result;
  }

  private operatorEquals(
    prefix: Paths<RxDocumentData<RxDocType>>,
    value: MangoQuerySelector<RxDocumentData<RxDocType>>,
  ): WhereConditions {
    const columnInfo = this.columnMap.get(prefix);
    const valueType = typeof value;
    if (columnInfo?.column) {
      if (
        (columnInfo.type === "string" && valueType === "string") ||
        (columnInfo.type === "number" && valueType === "number") ||
        (columnInfo.type === "boolean" && valueType === "boolean")
      ) {
        return {
          condition: `${columnInfo.column} = ?`,
          args: this.argsWithMangoQuerySelector(value),
        };
      } else if (valueType === "object") {
        return this.operatorAndObject(prefix, value);
      } else {
        throw new Error(
          `Type error.  Key ${prefix} is a ${columnInfo.type}.  Value ${value} is a ${typeof value}.`,
        );
      }
    } else if (columnInfo?.jsonPath) {
      if (
        (columnInfo.type === "string" && valueType === "string") ||
        (columnInfo.type === "number" && valueType === "number") ||
        (columnInfo.type === "boolean" && valueType === "boolean")
      ) {
        const jsonTransform = valueType === "boolean" ? "->" : "->>";
        return {
          condition: `jsonb ${jsonTransform} '${columnInfo.jsonPath}' = ?`,
          args: this.argsWithMangoQuerySelector(value, true),
        };
      } else if (valueType === "object") {
        return this.operatorAndObject(prefix, value);
      } else {
        throw new Error(
          `Type error.  Key ${prefix} is a ${columnInfo.type}.  Value ${value} is a ${valueType}.`,
        );
      }
    }
    // FIXME: need a better error
    console.dir(this.columnMap, { depth: null });
    throw new Error(`Unable to process query for prefix: ${prefix}`);
  }

  private operatorOrArray(
    prefix: Paths<RxDocumentData<RxDocType>>,
    selector: MangoQuerySelector<RxDocumentData<RxDocType>>[],
  ): WhereConditions {
    const conditions: WhereConditions[] = [];
    if (Array.isArray(selector)) {
      for (let i = 0; i < selector.length; i++) {
        const currentSelector = selector[i];
        if (typeof currentSelector === "object") {
          const innerConditions = this.operatorAndObject(
            prefix,
            currentSelector,
          );
          conditions.push(innerConditions);
        } else {
          throw new Error(
            `Every member of an $or array must be an object: selector[${i}] = ${currentSelector}`,
          );
        }
      }
    } else {
      throw new Error(
        `operatorOrArray received a non-Array argument ${selector}`,
      );
    }
    return this.joinConditionsOr(conditions);
  }

  private orderByWithPreparedQuery(
    preparedQuery: PreparedQuery<RxDocType>,
  ): OrderByClause {
    const parts: string[] = [];
    for (let i = 0; i < preparedQuery.query.sort.length; i++) {
      const sortKey: MangoQuerySortPart<RxDocumentData<RxDocType>> =
        preparedQuery.query.sort[i];
      for (const [k, value] of Object.entries(sortKey)) {
        const key = k as Paths<RxDocumentData<RxDocType>>;
        const columnInfo = this.columnMap.get(key);
        if (columnInfo === undefined) {
          throw new Error(`Missing information for document property ${key}`);
        } else if (value !== "asc" && value !== "desc") {
          throw new Error(
            `MangoQuerySortDirection is neither 'asc' nor 'desc': ${value}`,
          );
        }
        if (columnInfo?.column) {
          parts.push(columnInfo.column + " " + value.toUpperCase());
        } else if (columnInfo?.jsonPath) {
          parts.push(
            "jsonb ->> '" + columnInfo.jsonPath + "' " + value.toUpperCase(),
          );
        } else {
          throw new Error(
            `Unable to find a column or JSON path for document properties ${key}`,
          );
        }
      }
    }
    const result = parts.length ? "ORDER BY " + parts.join(", ") : "";
    return {
      clause: result,
    };
  }

  private prefixWithChild(
    prefix: Paths<RxDocumentData<RxDocType>> | string,
    child: Paths<RxDocumentData<RxDocType>> | string,
  ): Paths<RxDocumentData<RxDocType>> {
    const first = prefix ? prefix + "." : "";
    const result = (first + child) as Paths<RxDocumentData<RxDocType>>;
    return result;
  }

  private queryAndArgsWithWhereConditionsAndOrderBy(
    whereConditions: WhereConditions,
    orderBy: OrderByClause,
  ): QueryAndArgs {
    const query =
      "WHERE " +
      whereConditions.condition +
      (orderBy.clause ? " " + orderBy.clause : "");
    return {
      args: whereConditions.args,
      query,
    };
  }
}