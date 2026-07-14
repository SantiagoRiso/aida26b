import { structure } from "./structure";
import type { InferType } from "../types/types";

type TableKey = keyof typeof structure.tables;

type TableRecordMap = {
  [T in keyof typeof structure.tables]: InferType<(typeof structure.tables)[T]['columns']>
};

export type { TableKey, TableRecordMap };
