export type AdaptiveRecordType =
  'order' | 'product' | 'supplier' | 'purchase_order';

type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'boolean'
  | 'single_choice'
  | 'multi_choice'
  | 'person';

export type CustomFieldValue = string | number | boolean | string[] | null;

export interface CustomFieldInput {
  recordType: AdaptiveRecordType;
  key: string;
  label: { en: string; de: string };
  type: CustomFieldType;
  choices: { key: string; label: { en: string; de: string } }[];
  readPermission: string;
  writePermission: string;
}

export interface CustomField extends CustomFieldInput {
  id: string;
  revision: number;
  archived: boolean;
  source: 'luma' | 'provider';
  createdAt: string;
  updatedAt: string;
}

export interface CustomFieldRecordValue {
  fieldId: string;
  value: CustomFieldValue;
  revision: number;
  updatedAt: string;
  updatedBy: string;
}

export interface CustomFieldRecord {
  fields: CustomField[];
  values: CustomFieldRecordValue[];
}
