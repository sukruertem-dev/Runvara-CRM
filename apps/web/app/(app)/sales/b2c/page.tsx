import { redirect } from 'next/navigation';

/** B2C sales starts at the customers (P9d); orders join here in P9e. */
export default function B2cPage(): never {
  redirect('/sales/b2c/customers');
}
