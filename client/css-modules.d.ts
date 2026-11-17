/** CSS modules: the build scopes every class and maps the source name to the scoped one. */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
