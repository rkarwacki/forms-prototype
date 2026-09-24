import { contactForm } from './shared/form-definition';
import { json } from './shared/http';

// GET /config — form structure and dropdown options for the browser.
export const handler = async () => {
  return json(200, contactForm);
};
