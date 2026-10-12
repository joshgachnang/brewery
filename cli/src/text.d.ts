// Templates are imported as text so `bun build --compile` embeds them.
declare module "*.md" {
  const text: string;
  export default text;
}
