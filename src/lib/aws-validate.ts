/**
 * Lightweight validators for AWS identifiers supplied as scan inputs. These are
 * passed to container CLIs (Prowler / aws-cli) as arguments, so validate them to
 * keep the shapes sane and prevent shell-injection via region word-splitting.
 * Pure functions — safe to import anywhere.
 */

export function isValidRoleArn(value: string): boolean {
  return /^arn:aws[a-z-]*:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/.test(value);
}

export function isValidExternalId(value: string): boolean {
  // STS external id allowed character set.
  return /^[\w+=,.@:/-]{2,1224}$/.test(value);
}

export function isValidRegion(value: string): boolean {
  // Covers every real region format (us-east-2, eu-west-1, us-gov-west-1,
  // eusc-de-east-1, …) while excluding whitespace / shell metacharacters.
  return /^[a-z0-9-]{1,30}$/.test(value);
}

export function sanitizeRegions(regions: string[] | null | undefined): string[] {
  return (regions ?? []).filter(isValidRegion);
}
