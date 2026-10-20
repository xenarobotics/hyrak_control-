import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-[12px] font-bold whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-[var(--app-accent)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "border-app-accent/45 bg-app-accent-soft text-app-text [a]:hover:border-app-accent",
        secondary:
          "border-app-border bg-app-surface-2 text-app-text [a]:hover:border-app-border-strong",
        destructive:
          "border-app-danger/45 bg-app-danger-soft text-app-danger",
        outline:
          "border-app-border-strong text-app-text [a]:hover:bg-app-surface-2",
        ghost:
          "text-app-text-muted hover:bg-app-surface-2 hover:text-app-text",
        link: "text-app-accent underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
