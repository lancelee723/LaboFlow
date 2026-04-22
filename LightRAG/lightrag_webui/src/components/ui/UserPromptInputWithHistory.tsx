import React, { useState, useRef, useEffect, useCallback } from 'react'
import { ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import Input from './Input'

interface UserPromptInputWithHistoryProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  className?: string
  id?: string
  history: string[]
  onSelectFromHistory: (prompt: string) => void
  onDeleteFromHistory?: (index: number) => void
}

export default function UserPromptInputWithHistory({
  value,
  onChange,
  placeholder,
  className,
  id,
  history,
  onSelectFromHistory,
  onDeleteFromHistory
}: UserPromptInputWithHistoryProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [isHovered, setIsHovered] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
        setSelectedIndex(-1)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [])

  // Handle keyboard navigation
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' && history.length > 0) {
        e.preventDefault()
        setIsOpen(true)
        setSelectedIndex(0)
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev =>
          prev < history.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => prev > 0 ? prev - 1 : -1)
        if (selectedIndex === 0) {
          setSelectedIndex(-1)
        }
        break
      case 'Enter':
        if (selectedIndex >= 0 && selectedIndex < history.length) {
          e.preventDefault()
          const selectedPrompt = history[selectedIndex]
          onSelectFromHistory(selectedPrompt)
          setIsOpen(false)
          setSelectedIndex(-1)
        }
        break
      case 'Escape':
        e.preventDefault()
        setIsOpen(false)
        setSelectedIndex(-1)
        break
    }
  }, [isOpen, selectedIndex, history, onSelectFromHistory])

  const handleInputClick = () => {
    if (history.length > 0) {
      setIsOpen(!isOpen)
      setSelectedIndex(-1)
    }
  }

  const handleDropdownItemClick = (prompt: string) => {
    onSelectFromHistory(prompt)
    setIsOpen(false)
    setSelectedIndex(-1)
    inputRef.current?.focus()
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(e.target.value)
  }

  const handleMouseEnter = () => {
    setIsHovered(true)
  }

  const handleMouseLeave = () => {
    setIsHovered(false)
  }

  // Handle delete history item with boundary cases
  const handleDeleteHistoryItem = useCallback((index: number, e: React.MouseEvent) => {
    e.stopPropagation() // Prevent triggering item selection
    onDeleteFromHistory?.(index)

    // Handle boundary cases
    if (history.length === 1) {
      // Deleting the last item, close dropdown
      setIsOpen(false)
      setSelectedIndex(-1)
    } else if (selectedIndex === index) {
      // Deleting currently selected item, adjust selection
      setSelectedIndex(prev => prev > 0 ? prev - 1 : -1)
    } else if (selectedIndex > index) {
      // Deleting item before selected item, adjust index
      setSelectedIndex(prev => prev - 1)
    }
  }, [onDeleteFromHistory, history.length, selectedIndex])

  return (
    <div className="relative" ref={dropdownRef} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave}>
      <div className="relative">
        <Input
          ref={inputRef}
          id={id}
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onClick={handleInputClick}
          placeholder={placeholder}
          autoComplete="off"
          className={cn(
            isHovered && history.length > 0 ? 'pr-8' : 'pr-3',
            'w-full rounded-xl border-black/10 bg-white/90 shadow-none dark:border-white/10 dark:bg-white/8',
            className
          )}
        />
        {isHovered && history.length > 0 && (
          <button
            type="button"
            onClick={handleInputClick}
            className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[#8a847e] hover:bg-[#f2efea] hover:text-[#1f1e1c] transition-colors dark:text-white/50 dark:hover:bg-white/10 dark:hover:text-white"
            tabIndex={-1}
          >
            <ChevronDown
              className={cn(
                'h-3 w-3 transition-transform duration-200',
                isOpen && 'rotate-180'
              )}
            />
          </button>
        )}
      </div>

      {/* Dropdown */}
      {isOpen && history.length > 0 && (
        <div className="absolute top-full left-0 right-0 z-50 mt-1 max-h-96 min-w-0 overflow-auto rounded-[18px] border border-black/10 bg-[#fffdfb] p-1 shadow-[0_14px_28px_rgba(0,0,0,0.04),0_7px_15px_rgba(0,0,0,0.02),0_3px_7px_rgba(0,0,0,0.02),0_1px_3px_rgba(0,0,0,0.01)] dark:border-white/10 dark:bg-[#201d1a]">
          {history.map((prompt, index) => (
            <div
              key={index}
              className={cn(
                'flex items-center justify-between rounded-xl pl-3 pr-1 py-2 text-sm transition-colors',
                'border-b border-black/6 dark:border-white/8 last:border-b-0',
                'hover:bg-[#f6f5f4] dark:hover:bg-white/8',
                'focus-within:bg-[#f6f5f4] dark:focus-within:bg-white/8',
                selectedIndex === index && 'bg-[#f6f5f4] dark:bg-white/8'
              )}
            >
              <button
                type="button"
                onClick={() => handleDropdownItemClick(prompt)}
                className="mr-0 flex-1 truncate text-left text-[#31302e] focus:outline-none dark:text-white/85"
                title={prompt}
              >
                {prompt}
              </button>
              {onDeleteFromHistory && (
                <button
                  type="button"
                  onClick={(e) => handleDeleteHistoryItem(index, e)}
                  className="ml-auto flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md transition-colors hover:bg-red-100 hover:text-red-600 focus:outline-none dark:hover:bg-red-900/40 dark:hover:text-red-300"
                  title="Delete this history item"
                >
                  <X className="h-3 w-3 text-[#a39e98]" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
