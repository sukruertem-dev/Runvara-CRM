import enterpriseB2b from './enterprise-b2b.json';
import retailB2c from './retail-b2c.json';
import telesalesCallcenter from './telesales-callcenter.json';

/** Industry blueprints (CFG-04, ADR-0011 §3). Raw data: the API validates each one against the
 *  `ConfigBundle` contract when it starts and refuses to start if one is invalid. */
export const BLUEPRINTS: readonly unknown[] = [enterpriseB2b, retailB2c, telesalesCallcenter];
