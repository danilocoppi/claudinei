import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ColorField } from '../components/ColorField'

describe('ColorField', () => {
  it('mostra o hex atual e emite mudança', () => {
    const onChange = vi.fn()
    render(<ColorField value="#ff0000" onChange={onChange} />)
    expect(screen.getByText('#ff0000')).toBeTruthy()
    const input = screen.getByLabelText('cor') as HTMLInputElement
    fireEvent.input(input, { target: { value: '#00ff00' } })
    expect(onChange).toHaveBeenCalledWith('#00ff00')
  })
})
