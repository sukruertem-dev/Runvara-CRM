export type BinaryOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'and'
  | 'or';

export type Node =
  | { readonly kind: 'num'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'neg'; readonly arg: Node }
  | { readonly kind: 'not'; readonly arg: Node }
  | { readonly kind: 'bin'; readonly op: BinaryOp; readonly left: Node; readonly right: Node }
  | { readonly kind: 'call'; readonly name: string; readonly args: readonly Node[] };

export type Value = number | string | boolean | null;
