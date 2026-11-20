import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';

/** Boundary validation (CLAUDE.md: Zod at the edge). Throws ZodError → 400 problem+json. */
@Injectable()
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.infer<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.infer<S> {
    return this.schema.parse(value ?? {});
  }
}
