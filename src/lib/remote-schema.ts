export interface StandardSchema<Input, Output> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => { readonly value: Output } | { readonly issues: readonly { readonly message: string }[] };
    readonly types?: {
      readonly input: Input;
      readonly output: Output;
    };
  };
}
