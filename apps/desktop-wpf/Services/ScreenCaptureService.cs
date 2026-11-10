
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Interop;

namespace Fufuu.Wpf.Services;

public static class ScreenCaptureService
{
    private const int SrcCopy = 0x00CC0020;
    private const int CaptureLayeredWindows = 0x40000000;

    private const int SmCxScreen = 0;
    private const int SmCyScreen = 1;

    [StructLayout(LayoutKind.Sequential)]
    private struct BitmapInfoHeader
    {
        public uint Size;
        public int Width;
        public int Height;
        public ushort Planes;
        public ushort BitCount;
        public uint Compression;
        public uint SizeImage;
        public int XPelsPerMeter;
        public int YPelsPerMeter;
        public uint ColorsUsed;
        public uint ColorsImportant;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetDesktopWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetWindowDC(IntPtr hwnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateCompatibleDC(IntPtr hdc);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr CreateCompatibleBitmap(
        IntPtr hdc,
        int width,
        int height);

    [DllImport("gdi32.dll", SetLastError = true)]
    private static extern IntPtr SelectObject(
        IntPtr hdc,
        IntPtr obj);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool BitBlt(
        IntPtr destination,
        int x,
        int y,
        int width,
        int height,
        IntPtr source,
        int sourceX,
        int sourceY,
        int operation);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("gdi32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteDC(IntPtr hdc);

    /// <summary>
    /// Captures the primary display and returns its JPEG image as base64.
    /// This method does not write screenshots to disk.
    /// </summary>
    /// <param name="maxWidth">
    /// Maximum output width in pixels. The aspect ratio is preserved.
    /// </param>
    /// <param name="quality">
    /// JPEG quality from 1 to 100.
    /// </param>
    public static string CapturePrimaryScreenAsBase64(
        int maxWidth = 1280,
        long quality = 70L)
    {
        if (maxWidth <= 0)
        {
            throw new ArgumentOutOfRangeException(
                nameof(maxWidth),
                "Maximum width must be greater than zero.");
        }

        quality = Math.Clamp(quality, 1L, 100L);

        int width = GetSystemMetrics(SmCxScreen);
        int height = GetSystemMetrics(SmCyScreen);

        if (width <= 0 || height <= 0)
        {
            throw new InvalidOperationException(
                "Could not determine the primary screen dimensions.");
        }

        IntPtr desktop = GetDesktopWindow();

        if (desktop == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                "Could not access the desktop window.");
        }

        IntPtr sourceDc = GetWindowDC(desktop);

        if (sourceDc == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                "Could not acquire the desktop device context.");
        }

        IntPtr memoryDc = IntPtr.Zero;
        IntPtr bitmap = IntPtr.Zero;
        IntPtr oldObject = IntPtr.Zero;

        try
        {
            memoryDc = CreateCompatibleDC(sourceDc);

            if (memoryDc == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "Could not create a compatible device context.");
            }

            bitmap = CreateCompatibleBitmap(
                sourceDc,
                width,
                height);

            if (bitmap == IntPtr.Zero)
            {
                throw new InvalidOperationException(
                    "Could not allocate the screenshot bitmap.");
            }

            oldObject = SelectObject(memoryDc, bitmap);

            if (oldObject == IntPtr.Zero ||
                oldObject == new IntPtr(-1))
            {
                oldObject = IntPtr.Zero;

                throw new InvalidOperationException(
                    "Could not select the screenshot bitmap.");
            }

            if (!BitBlt(
                    memoryDc,
                    0,
                    0,
                    width,
                    height,
                    sourceDc,
                    0,
                    0,
                    SrcCopy | CaptureLayeredWindows))
            {
                throw new InvalidOperationException(
                    "Windows could not copy the desktop image.");
            }

            BitmapSource source =
                Imaging.CreateBitmapSourceFromHBitmap(
                    bitmap,
                    IntPtr.Zero,
                    Int32Rect.Empty,
                    BitmapSizeOptions.FromEmptyOptions());

            source.Freeze();

            double scale = Math.Min(
                1.0,
                (double)maxWidth / source.PixelWidth);

            BitmapSource output = source;

            if (scale < 1.0)
            {
                var transformed = new TransformedBitmap(
                    source,
                    new ScaleTransform(scale, scale));

                transformed.Freeze();
                output = transformed;
            }

            using var memory = new MemoryStream();

            var encoder = new JpegBitmapEncoder
            {
                QualityLevel = (int)quality
            };

            encoder.Frames.Add(BitmapFrame.Create(output));
            encoder.Save(memory);

            return Convert.ToBase64String(memory.ToArray());
        }
        finally
        {
            // Restore the original GDI object before deleting the bitmap.
            if (oldObject != IntPtr.Zero &&
                memoryDc != IntPtr.Zero)
            {
                SelectObject(memoryDc, oldObject);
            }

            if (bitmap != IntPtr.Zero)
            {
                DeleteObject(bitmap);
            }

            if (memoryDc != IntPtr.Zero)
            {
                DeleteDC(memoryDc);
            }

            ReleaseDC(desktop, sourceDc);
        }
    }
}
