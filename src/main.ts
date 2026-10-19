/**
 * AuraFlow Web — main entry
 * Loads the design system + wires shared chrome on every page.
 */

import './styles/tokens.css';
import './styles/base.css';
import './styles/site.css';
import { mountChrome } from './site/layout.js';

mountChrome();
