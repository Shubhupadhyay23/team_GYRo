"use client";

import { useState, useEffect } from "react";
import { parsePhoneNumber, isValidPhoneNumber, CountryCode } from "libphonenumber-js";

interface PhoneInputProps {
  value: string;
  onChange: (value: string) => void;
  defaultCountry?: CountryCode;
  error?: string;
}

export default function PhoneInput({
  value,
  onChange,
  defaultCountry = "IN",
  error,
}: PhoneInputProps) {
  const [isValid, setIsValid] = useState<boolean | null>(null);
  const [displayValue, setDisplayValue] = useState(value);

  useEffect(() => {
    setDisplayValue(value);
  }, [value]);

  const handleChange = (inputValue: string) => {
    setDisplayValue(inputValue);

    // Allow empty input
    if (!inputValue.trim()) {
      setIsValid(null);
      onChange("");
      return;
    }

    try {
      // Try to parse and validate the phone number
      const valid = isValidPhoneNumber(inputValue, defaultCountry);
      setIsValid(valid);

      if (valid) {
        // Convert to E.164 format
        const phoneNumber = parsePhoneNumber(inputValue, defaultCountry);
        if (phoneNumber) {
          onChange(phoneNumber.format("E.164"));
        }
      } else {
        onChange(inputValue); // Pass raw value for validation error handling
      }
    } catch {
      setIsValid(false);
      onChange(inputValue);
    }
  };

  const showValidation = displayValue.length > 0 && isValid !== null;

  return (
    <div className="w-full">
      <label className="block text-xs font-semibold mb-1 text-zinc-300">
        Phone number
      </label>
      <div className="relative">
        <input
          type="tel"
          value={displayValue}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="+91 98765 43210"
          className={`w-full px-3 py-2.5 pr-10 border rounded-xl text-sm bg-white/5 text-white placeholder-zinc-500 focus:outline-none focus:ring-2 transition-all ${
            showValidation
              ? isValid
                ? "border-green-500 focus:ring-green-500/50"
                : "border-red-500 focus:ring-red-500/50"
              : "border-white/10 focus:ring-indigo-500/50 focus:border-indigo-400"
          }`}
        />
        {showValidation && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {isValid ? (
              <span className="text-green-400 text-sm">✓</span>
            ) : (
              <span className="text-red-400 text-sm">✕</span>
            )}
          </div>
        )}
      </div>
      {error && <p className="text-red-400 text-xs mt-1 font-medium">{error}</p>}
      {showValidation && !isValid && !error && (
        <p className="text-red-400 text-xs mt-1 font-medium">Invalid phone number</p>
      )}
    </div>
  );
}
