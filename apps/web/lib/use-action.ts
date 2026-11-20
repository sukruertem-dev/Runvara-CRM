'use client';

import { useCallback, useState } from 'react';
import { NO_ERRORS, parseFormError, type FormErrors } from './errors';

/** Runs an async submit handler with pending state and parsed API errors. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FormErrors>(NO_ERRORS);

  const run = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setPending(true);
    setErrors(NO_ERRORS);
    try {
      await fn();
    } catch (err) {
      setErrors(parseFormError(err));
    } finally {
      setPending(false);
    }
  }, []);

  const fail = useCallback((next: FormErrors) => {
    setErrors(next);
  }, []);

  return { pending, errors, run, fail };
}
