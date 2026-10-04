/** Sample photos bundled for demo sessions (Wikimedia Commons, see
 *  tests/fixtures/images/ATTRIBUTION.json). Different photos of the same
 *  subject are deliberately included so matching can be tried without a camera. */
export const DEMO_SAMPLES = [
  { file: '/demo/golden-2.jpg', label: 'Dog (another photo)', hint: 'Matches Question #1' },
  { file: '/demo/golden-3.jpg', label: 'Dog (third photo)', hint: 'Matches Question #1' },
  { file: '/demo/golden-puppy.jpg', label: 'Puppy', hint: 'Uncertain match' },
  { file: '/demo/labrador-1.jpg', label: 'Different dog', hint: 'Uncertain match' },
  { file: '/demo/eiffel-2.jpg', label: 'Tower (another photo)', hint: 'Uncertain match' },
  { file: '/demo/bridge-2.jpg', label: 'Bridge (another photo)', hint: 'Matches a question' },
  { file: '/demo/apple-1.jpg', label: 'Apple', hint: 'New question' },
  { file: '/demo/tomato-1.jpg', label: 'Tomato', hint: 'New question' },
  { file: '/demo/cat-2.jpg', label: 'Cat', hint: 'New or uncertain' },
] as const;
