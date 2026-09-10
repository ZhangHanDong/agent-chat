import { expect, test } from 'vitest';
import OnboardPage from '../mockup/app/onboard/page.jsx';

test('old agent creation route redirects to resource configuration', () => {
  // Exercise Next's actual redirect, including destination and HTTP status.
  let navigation;
  try { OnboardPage(); } catch (error) { navigation = error; }
  expect(navigation?.digest).toBe('NEXT_REDIRECT;replace;/resources;307;');
});
