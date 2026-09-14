// The site's three sections, and the categories each one is allowed to use.
//
// Every entry lives in recipes.json. An entry's `section` key says which part
// of the site it belongs to; an entry with no `section` key is a recipe, which
// keeps every recipe written before sections existed valid as it is.
//
// KEEP THESE LISTS IN STEP WITH site.json. The browser offers what site.json
// lists (`categories` for recipes, `sections.<id>.categories` for the others);
// the API accepts what is listed here. A category in one but not the other is
// either never offered or silently replaced on save.

export const SECTIONS = ['recipes', 'health', 'questions'];

const CATEGORIES = {
  recipes: [
    'Stir-Fry', 'Noodles', 'Soup', 'Rice', 'Meat & Seafood',
    'Salad', 'Breakfast', 'Kuih', 'Bread & Pau', 'Cake',
    'Dessert', 'Drinks', 'Pickles', 'Sides & Sauces'
  ],
  health: [
    'Nutrition', 'Home Remedies', 'Herbal & Tonics', 'Fitness', 'Wellbeing'
  ],
  // Questions holds quizzes, one per topic, so these are broad subject areas.
  questions: [
    'Health & Medicine', 'Nutrition & Diet', 'Cooking & Food', 'Science',
    'General Knowledge', 'Other'
  ]
};

// Used when nothing valid was chosen: the broadest bucket in each section.
const DEFAULTS = {
  recipes: 'Stir-Fry',
  health: 'Wellbeing',
  questions: 'Other'
};

/** Any unknown or missing value means a recipe. */
export function sectionOf(value) {
  return SECTIONS.includes(value) ? value : 'recipes';
}

export function categoriesFor(section) {
  return CATEGORIES[sectionOf(section)];
}

export function defaultCategory(section) {
  return DEFAULTS[sectionOf(section)];
}
