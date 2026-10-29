
using System.Linq;
using System.Windows;

namespace Fufuu.Wpf.Pet;

public partial class FufuuControlWindow : Window
{
    private readonly DesktopPetWindow _petWindow;

    public FufuuControlWindow(DesktopPetWindow petWindow)
    {
        InitializeComponent();

        _petWindow = petWindow;
    }

    private void OnSwitchModeClicked(object sender, RoutedEventArgs e)
    {
        _petWindow.SendToWeb(new { type = "toggle-display-mode" });
    }

    private void OnOpenChatClicked(object sender, RoutedEventArgs e)
    {
        _petWindow.SendToWeb(new { type = "open-chat" });
    }

    private void OnPreferencesClicked(object sender, RoutedEventArgs e)
    {
        var existingWindow = System.Windows.Application.Current.Windows
            .OfType<PetPreferencesWindow>()
            .FirstOrDefault();

        if (existingWindow is null)
        {
            var preferencesWindow = new PetPreferencesWindow(_petWindow)
            {
                Owner = this,
            };

            preferencesWindow.Show();
        }
        else
        {
            if (existingWindow.WindowState == WindowState.Minimized)
            {
                existingWindow.WindowState = WindowState.Normal;
            }

            existingWindow.Activate();
        }
    }

    private void OnQuitClicked(object sender, RoutedEventArgs e)
    {
        _petWindow.Close();
        Close();
    }
}
