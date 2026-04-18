"use client"

import * as React from "react"
import { FormProvider, type UseFormReturn } from "react-hook-form"

function Form<TFieldValues extends Record<string, unknown>>({
  children,
  ...form
}: UseFormReturn<TFieldValues> & { children: React.ReactNode }) {
  return <FormProvider {...form}>{children}</FormProvider>
}

export { Form }
