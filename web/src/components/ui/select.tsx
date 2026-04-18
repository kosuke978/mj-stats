import * as React from "react"

import { cn } from "@/lib/utils"

type SelectContextValue = {
  value: string
  onValueChange?: (value: string) => void
}

const SelectContext = React.createContext<SelectContextValue | null>(null)

type SelectProps = {
  value?: string
  defaultValue?: string
  onValueChange?: (value: string) => void
  children: React.ReactNode
  disabled?: boolean
}

function Select({ value, defaultValue = "", onValueChange, children, disabled }: SelectProps) {
  const [internalValue, setInternalValue] = React.useState(defaultValue)
  const isControlled = value !== undefined
  const currentValue = isControlled ? value : internalValue

  const handleValueChange = (nextValue: string) => {
    if (!isControlled) {
      setInternalValue(nextValue)
    }
    onValueChange?.(nextValue)
  }

  return (
    <SelectContext.Provider value={{ value: currentValue, onValueChange: handleValueChange }}>
      <div data-slot="select" aria-disabled={disabled ? "true" : "false"} className={disabled ? "opacity-60" : undefined}>
        {children}
      </div>
    </SelectContext.Provider>
  )
}

function SelectTrigger({ className, children }: { className?: string; children?: React.ReactNode }) {
  const context = React.useContext(SelectContext)

  if (!context) {
    return null
  }

  let placeholder = "選択してください"
  const items: React.ReactElement[] = []

  React.Children.forEach(children, (child) => {
    if (!React.isValidElement(child)) {
      return
    }

    if (child.type === SelectValue) {
      const props = child.props as { placeholder?: string }
      if (props.placeholder) {
        placeholder = props.placeholder
      }
    }

    if (child.type === SelectContent) {
      const contentProps = child.props as { children?: React.ReactNode }
      React.Children.forEach(contentProps.children, (item) => {
        if (React.isValidElement(item) && item.type === SelectItem) {
          items.push(item)
        }
      })
    }
  })

  return (
    <select
      data-slot="select-trigger"
      className={cn(
        "h-11 w-full rounded-md border border-input bg-background px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/40",
        className
      )}
      value={context.value}
      onChange={(event) => context.onValueChange?.(event.target.value)}
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {items.map((item, index) => {
        const props = item.props as { value: string; children?: React.ReactNode }
        return (
          <option key={`${props.value}-${index}`} value={props.value}>
            {props.children}
          </option>
        )
      })}
    </select>
  )
}

function SelectValue(props: { placeholder?: string }) {
  void props
  return null
}

function SelectContent({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

function SelectItem(props: { value: string; children: React.ReactNode }) {
  void props
  return null
}

export { Select, SelectContent, SelectItem, SelectTrigger, SelectValue }
