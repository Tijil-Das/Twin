import { cn } from "@/lib/utils";

interface FolderIconProps {
  className?: string;
  color?: string | null;
  size?: number;
}

/**
 * GitHub Primer Octicon Directory Fill
 * Classic solid folder graphic matching GitHub's repository tree and web UI.
 */
export function GithubFolderIcon({ className, color, size = 16 }: FolderIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn("shrink-0 fill-current", !color && "text-[#54aeff]", className)}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z" />
    </svg>
  );
}

/**
 * GitHub Primer Octicon Open Directory Fill
 */
export function GithubFolderOpenIcon({ className, color, size = 16 }: FolderIconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn("shrink-0 fill-current", !color && "text-[#54aeff]", className)}
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Zm4.83 5H14.5a.75.75 0 0 1 .73.918l-1.5 6.5a.75.75 0 0 1-.73.582H2.5a.75.75 0 0 1-.73-.918l1.5-6.5A.75.75 0 0 1 4 6h2.58Z" />
    </svg>
  );
}

/**
 * GitHub Primer Folder with Plus badge for creating / adding new folders.
 */
export function GithubFolderPlusIcon({ className, color, size = 16 }: FolderIconProps) {
  const folderColor = color || "#54aeff";
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      {/* GitHub Folder Body */}
      <path
        d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h7.2a1.75 1.75 0 0 1-.2-.8v-.2a2.5 2.5 0 0 1 2.5-2.5h3.25c.42 0 .81.1 1.15.29.22-.44.35-.95.35-1.49v-5.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"
        fill={folderColor}
      />
      {/* Plus Accent */}
      <circle cx="12.5" cy="12.5" r="3.5" fill="#238636" stroke="#0d1117" strokeWidth="1" />
      <path
        d="M12.5 10.5v4M10.5 12.5h4"
        stroke="#ffffff"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * GitHub Primer Folder with Search / Browse accent
 */
export function GithubFolderSearchIcon({ className, color, size = 16 }: FolderIconProps) {
  const folderColor = color || "#54aeff";
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      className={cn("shrink-0", className)}
      aria-hidden="true"
    >
      <path
        d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h6.5a2.5 2.5 0 0 1-.25-1H1.75a.25.25 0 0 1-.25-.25v-8.5a.25.25 0 0 1 .25-.25H7.5a.25.25 0 0 0 .2-.1l.9-1.2c.23-.306.75-.566 1.3-.566H14.25c.138 0 .25.112.25.25v4.5c.34.1.65.25.92.45.36-.45.58-1.03.58-1.7V4.75A1.75 1.75 0 0 0 14.25 3H9.9l-.9-1.2C8.32.26 7.8 0 7.25 0H1.75Z"
        fill={folderColor}
      />
      <circle cx="12" cy="12" r="2.5" fill="none" stroke="#58a6ff" strokeWidth="1.2" />
      <path d="M13.8 13.8l1.7 1.7" stroke="#58a6ff" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
