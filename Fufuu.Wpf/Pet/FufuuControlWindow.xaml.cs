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
        // Check if the preferences window is already open to avoid spamming multiple windows
        var existingWindow = System.Windows.Application.Current.Windows
            .OfType<PetPreferencesWindow>()
            .FirstOrDefault();

        if (existingWindow == null)
        {
            var preferencesWindow = new PetPreferencesWindow(_petWindow)
            {
                Owner = this,
            };
            preferencesWindow.Show();
        }
        else
        {
            existingWindow.Activate();
        }
    }

    private void OnQuitClicked(object sender, RoutedEventArgs e)
    {
        _petWindow.Close();
        Close();
    }
}
